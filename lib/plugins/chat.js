const { once } = require('events')

const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`)

module.exports = inject

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  const defaultChatPatterns = options.defaultChatPatterns ?? true

  const ChatMessage = require('prismarine-chat')(bot.registry)
  // chat.pattern.type will emit an event for bot.on() of the same type, eg chatType = whisper will trigger bot.on('whisper')
  const _patterns = {}
  let _length = 0
  // deprecated
  bot.chatAddPattern = (patternValue, typeValue) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true })
  }

  bot.addChatPatternSet = (name, patterns, opts = {}) => {
    if (!patterns.every(p => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, parse = false } = opts
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse
    }
    return _length
  }

  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, deprecated = false, parse = false } = opts
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse
    }
    return _length++ // increment length after we give it back to the user
  }

  bot.removeChatPattern = name => {
    if (typeof name === 'number') {
      _patterns[name] = undefined
    } else {
      const matchingPatterns = Object.entries(_patterns).filter(pattern => pattern[1]?.name === name)
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined
      })
    }
  }

  function findMatchingPatterns (msg) {
    const found = []
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue
      const { position, patterns } = pattern
      if (patterns[position].test(msg)) {
        found.push(+indexString)
      }
    }
    return found
  }

  bot.on('messagestr', (msg, _, originalMsg) => {
    const foundPatterns = findMatchingPatterns(msg)

    for (const ix of foundPatterns) {
      _patterns[ix].matches.push(msg)
      _patterns[ix].messages.push(originalMsg)
      _patterns[ix].position++

      if (_patterns[ix].deprecated) {
        const [, ...matches] = _patterns[ix].matches[0].match(_patterns[ix].patterns[0])
        bot.emit(_patterns[ix].name, ...matches, _patterns[ix].messages[0].translate, ..._patterns[ix].messages)
        _patterns[ix].messages = [] // clear out old messages
      } else { // regular parsing
        if (_patterns[ix].patterns.length > _patterns[ix].matches.length) return // we have all the matches, so we can emit the done event
        if (_patterns[ix].parse) {
          const matches = _patterns[ix].patterns.map((pattern, i) => {
            const [, ...matches] = _patterns[ix].matches[i].match(pattern) // delete full message match
            return matches
          })
          bot.emit(`chat:${_patterns[ix].name}`, matches)
        } else {
          bot.emit(`chat:${_patterns[ix].name}`, _patterns[ix].matches)
        }
        // these are possibly null-ish if the user deletes them as soon as the event for the match is emitted
      }
      if (_patterns[ix]?.repeat) {
        _patterns[ix].position = 0
        _patterns[ix].matches = []
      } else {
        _patterns[ix] = undefined
      }
    }
  })

  addDefaultPatterns()

  bot._client.on('playerChat', (data) => {
    const message = data.formattedMessage
    const verified = data.verified
    let msg
    if (bot.supportFeature('clientsideChatFormatting')) {
      let sender

      try {
        sender = JSON.parse(data.senderName)
      } catch {
        sender = {
          insertion: data.senderName,
          clickEvent: { action: 'suggest_command', value: `/tell ${data.senderName} ` },
          hoverEvent: { action: 'show_entity', contents: { id: bot.findPlayer(data.senderName).id, name: data.senderName } },
          text: data.senderName
        }
      }

      const parameters = {
        sender,
        content: message ? JSON.parse(message) : { text: data.plainMessage }
      }
      msg = ChatMessage.fromNetwork(data.type, parameters)

      if (data.unsignedContent) {
        msg.unsigned = ChatMessage.fromNetwork(data.type, { sender, content: JSON.parse(data.unsignedContent) })
      }
    } else {
      msg = ChatMessage.fromNotch(data.formattedMessage)
    }
    bot.emit('message', msg, 'chat', data.sender, verified)
    bot.emit('messagestr', msg.toString(), 'chat', msg, data.sender, verified)
  })

  bot._client.on('systemChat', (data) => {
    const msg = ChatMessage.fromNotch(data.formattedMessage)
    const chatPositions = {
      1: 'system',
      2: 'game_info'
    }
    bot.emit('message', msg, chatPositions[data.positionid], null)
    bot.emit('messagestr', msg.toString(), chatPositions[data.positionid], msg, null)
    if (data.positionid === 2) bot.emit('actionBar', msg, null)
  })

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Incorrect type! Should be a string or number.')
    }

    if (bot.supportFeature('signedChat')) {
      if (message.startsWith('/')) {
        // We send commands as Chat Command packet in 1.19+
        const command = message.slice(1)
        const timestamp = BigInt(Date.now())
        bot._client.write('chat_command', {
          command,
          timestamp,
          salt: 0n,
          argumentSignatures: [],
          signedPreview: false,
          // 1.19.2 Chat Command packet also includes an array of last seen messages
          previousMessages: []
        })
        return
      }
    }

    const lengthLimit = CHAT_LENGTH_LIMIT - header.length
    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return
      let i
      let smallMsg
      for (i = 0; i < subMessage.length; i += lengthLimit) {
        smallMsg = header + subMessage.substring(i, i + lengthLimit)
        bot._client.chat(smallMsg)
      }
    })
  }

  async function tabComplete (text, assumeCommand = false, sendBlockInSight = true) {
    let position

    if (sendBlockInSight) {
      const block = bot.blockAtCursor()

      if (block) {
        position = block.position
      }
    }

    bot._client.write('tab_complete', {
      text,
      assumeCommand,
      lookedAtBlock: position
    })

    const [packet] = await once(bot._client, 'tab_complete')
    return packet.matches
  }

  bot.whisper = (username, message) => {
    chatWithHeader(`/tell ${username} `, message)
  }
  bot.chat = (message) => {
    chatWithHeader('', message)
  }

  bot.tabComplete = tabComplete

  function addDefaultPatterns () {
    // 1.19 changes the chat format to move <sender> prefix from message contents to a seperate field.
    // TODO: new chat lister to handle this
    if (!defaultChatPatterns) return
    bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true })
    bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true })
    bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
  }

  function awaitMessage (...args) {
    return new Promise((resolve, reject) => {
      const resolveMessages = args.flatMap(x => x)
      function messageListener (msg) {
        if (resolveMessages.some(x => x instanceof RegExp ? x.test(msg) : msg === x)) {
          resolve(msg)
          bot.off('messagestr', messageListener)
        }
      }
      bot.on('messagestr', messageListener)
    })
  }
  bot.awaitMessage = awaitMessage
}
