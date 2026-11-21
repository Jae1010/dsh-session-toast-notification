/*
 * Session Toast — browser half.
 *
 * Two jobs:
 *  1. the toast a click activates cannot talk to the page directly, so the click
 *     handler records the session id and this module picks it up from the host
 *     route, then switches the workspace to that conversation;
 *  2. the plugin page gets its switches (`plugins.bundle.config`): which
 *     notifications fire, and which sound each one plays.
 *
 * Guest code: it is loaded by `window.__ModuleLoader__`, so it hands back a
 * module object with `name`, `inject` and `apply` instead of using ESM exports.
 * Nothing here may throw: a broken guest module fails the client boot audit.
 */
window.__ModuleLoader__.load({
  id: 'session-toast-notification',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // Newest path first; the unversioned one is what 1.1.0 shipped and is still
    // served by the module generation that was loaded before an upgrade.
    var BASES = ['/dsh-session-toast-v2', '/dsh-session-toast']
    var INTERVAL_MS = 1500
    // Turning a quiet window on writes this window, so the switch alone is
    // enough; the pickers only ever refine it.
    var QUIET_DEFAULT_FROM = '22:00'
    var QUIET_DEFAULT_TO = '08:00'
    // Quarter-hour slots: fine enough for a mute window, short enough to scan.
    var TIME_OPTIONS = (function () {
      var slots = []
      for (var hour = 0; hour < 24; hour += 1) {
        for (var minute = 0; minute < 60; minute += 15) {
          slots.push((hour < 10 ? '0' : '') + hour + ':' + (minute < 10 ? '0' : '') + minute)
        }
      }
      return slots
    })()
    /** Package name is also the key of the bundle-configuration slot. */
    var BUNDLE = 'session-toast-notification'

    var React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }
    var h = React ? React.createElement : null

    exports.name = 'session-toast-notification-client'
    exports.inject = ['slots', 'uiWorkspace']

    exports.apply = function apply(ctx) {
      // Read the language once more here: the service exists by now even if the
      // document was still English when this module was loaded.
      localeRuntime = localeOf(ctx)
      refreshCopy()
      startClickWatcher(ctx)
      startPresence(ctx)
      startMacNotifier(ctx)
      startGrantWatcher(ctx)
      registerSettings(ctx)
    }

    /** The locale service, read softly so a page without it still boots. */
    function localeOf(ctx) {
      try {
        if (typeof ctx.get === 'function') return ctx.get('locale') || null
      } catch {
        return null
      }
      return null
    }

    // ---------------------------------------------------------------------
    // Answer a pending request from the notification button
    // ---------------------------------------------------------------------
    //
    // The page's own approval UI publishes each pending request through
    // `uiSession`, and that is also the object that settles the host waterfall.
    // A notification button therefore answers that object instead of trying to
    // claim the host request a second time.

    var sessionGrants = {}
    // call -> answers already picked for a batch of questions, keyed by question
    // index; dropped once the whole batch is submitted.
    var picks = {}

    function grantKey(toolName, reason) {
      return String(toolName || '') + '\n' + String(reason || '')
    }

    /**
     * The session UI service, read softly: the notification buttons are an
     * enhancement, so a page without that service still boots this module.
     */
    function uiSessionOf(ctx) {
      try {
        if (typeof ctx.get === 'function') return ctx.get('uiSession')
      } catch {
        return undefined
      }
      return undefined
    }

    function pendingList(ctx) {
      var out = []
      try {
        var ui = uiSessionOf(ctx)
        var store = ui && ui.sessionStatus
        var snapshot = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined
        if (!snapshot || typeof snapshot.forEach !== 'function') return out
        snapshot.forEach(function (status) {
          var pending = status && status.pendingInteraction
          if (pending && pending.answerable !== false) out.push(pending)
        })
      } catch {
        // Without the status store notifications still work; only the buttons
        // would have nothing to answer.
      }
      return out
    }

    function findApproval(ctx, call) {
      var list = pendingList(ctx)
      var i
      for (i = 0; i < list.length; i += 1) {
        if (list[i].kind === 'approval' && call && String(list[i].callId || '') === call) return list[i]
      }
      return undefined
    }

    /** The question card of a tool call, so an option button can answer it. */
    function findQuestion(ctx, call) {
      var list = pendingList(ctx)
      var i
      for (i = 0; i < list.length; i += 1) {
        if (list[i].kind !== 'approval' && call && String(list[i].callId || '') === call) return list[i]
      }
      // A question card may not carry the tool call id at all; when the page is
      // showing exactly one question, that is the one the toast came from.
      var open = []
      for (i = 0; i < list.length; i += 1) {
        if (list[i].kind !== 'approval' && typeof list[i].answer === 'function') open.push(list[i])
      }
      return open.length === 1 ? open[0] : undefined
    }

    /**
     * Answer the question the page is showing from an option button on the
     * toast. A single question is submitted straight away; a batch of questions
     * is walked one question at a time - the pick is remembered here, the next
     * question is put on screen by the host, and the whole set is submitted once
     * every question has an answer.
     */
    async function answerFromToast(ctx, base, call, index, step) {
      var pending = findQuestion(ctx, call)
      if (!pending) return { ok: false, error: 'no open question card' }
      try {
        var questions = Array.isArray(pending.questions) ? pending.questions : []
        if (questions.length === 0) return { ok: false, error: 'card has no question' }
        var at = Math.max(0, Math.min(Number(step) || 0, questions.length - 1))
        var asked = questions[at]
        var options = asked && Array.isArray(asked.options) ? asked.options : []
        var option = options[Number(index) || 0]
        if (!option) return { ok: false, error: 'no option ' + index }
        var label = String(option.label)

        if (questions.length === 1) {
          await pending.answer({
            answers: [{ id: String(asked.id || '0'), selected: [label] }],
          })
          return { ok: true }
        }

        // Remember the pick for this question, then either move the toast on to
        // the next unanswered one or submit the finished batch.
        var draft = picks[call]
        if (!draft) {
          draft = new Map()
          picks[call] = draft
        }
        draft.set(at, label)
        var next = -1
        for (var i = 0; i < questions.length; i += 1) {
          if (draft.has(i)) continue
          var list = questions[i] && Array.isArray(questions[i].options) ? questions[i].options : []
          if (list.length === 0) return { ok: false, error: 'question ' + i + ' needs typing' }
          next = i
          break
        }
        if (next >= 0) {
          try {
            await fetch(base + '/step', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ call: call, step: next }),
              keepalive: true,
            })
          } catch (error) {
            console.warn('[session-toast] could not show the next question', error)
          }
          return { ok: true, error: 'next question' }
        }
        var answers = []
        for (var k = 0; k < questions.length; k += 1) {
          answers.push({ id: String(questions[k].id || String(k)), selected: [String(draft.get(k))] })
        }
        picks[call] = null
        await pending.answer({ answers: answers })
        return { ok: true }
      } catch (error) {
        console.warn('[session-toast] answering from the toast failed', error)
        return { ok: false, error: error && error.message ? String(error.message).slice(0, 120) : 'answer failed' }
      }
    }
    /** Auto-answer later requests covered by an "allow for this session" click. */
    function startGrantWatcher(ctx) {
      var ui = uiSessionOf(ctx)
      var store = ui && ui.sessionStatus
      if (!store || typeof store.subscribe !== 'function') return
      try {
        ctx.effect(function () {
          function check() {
            var list = pendingList(ctx)
            for (var i = 0; i < list.length; i += 1) {
              var pending = list[i]
              if (pending.kind !== 'approval' || pending.answerable === false) continue
              var granted = sessionGrants[String(pending.sessionId || '')]
              if (!granted || granted[grantKey(pending.toolName, pending.reason)] !== true) continue
              try {
                pending.answer('allowed-once')
              } catch {
                // The request may have settled between the snapshot and here.
              }
            }
          }
          var dispose = store.subscribe(check)
          check()
          return dispose
        })
      } catch (error) {
        console.warn('[session-toast] grant watcher failed', error)
      }
    }

    // ---------------------------------------------------------------------
    // Tell the host which conversation is on screen
    // ---------------------------------------------------------------------
    //
    // A session-scoped slot receives the rendered `sessionId`, so a component
    // that renders nothing at all is enough to learn "the user is looking at
    // this conversation" without reading any private state.

    function startPresence(ctx) {
      if (!React || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      try {
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'session-toast-presence',
            order: 90,
            label: function () { return '' },
          }, PresenceReporter)
        })
      } catch (error) {
        console.warn('[session-toast] presence not registered', error)
      }
    }

    function PresenceReporter(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''

      React.useEffect(function () {
        if (!sessionId) return undefined
        var alive = true

        function post(base, body) {
          return fetch(base + '/presence', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
          }).catch(function () {})
        }

        function send() {
          if (!alive) return
          var focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
          var visible = document.hidden !== true
          for (var i = 0; i < BASES.length; i++) {
            try {
              post(BASES[i], { sessionId: sessionId, focused: focused && visible, visible: visible })
              return
            } catch {
              // Try the next path.
            }
          }
        }

        send()
        window.addEventListener('focus', send)
        window.addEventListener('blur', send)
        document.addEventListener('visibilitychange', send)
        return function () {
          alive = false
          window.removeEventListener('focus', send)
          window.removeEventListener('blur', send)
          document.removeEventListener('visibilitychange', send)
          // Leaving the conversation means it is no longer being watched.
          try {
            post(BASES[0], { sessionId: '', focused: false, visible: false })
          } catch {
            // Nothing to clean up.
          }
        }
      }, [sessionId])

      return null
    }

    // ---------------------------------------------------------------------
    // Click a toast -> open that session
    // ---------------------------------------------------------------------

    function startClickWatcher(ctx) {
      var stopped = false
      var timer

      async function poll(base) {
        const response = await fetch(base + '/pending', {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return undefined
        const body = await response.json()
        if (!body || typeof body !== 'object') return ''
        if (body.action && body.call) {
          return {
            action: String(body.action),
            call: String(body.call),
            index: Number(body.index || 0),
            step: Number(body.step || 0),
          }
        }
        return typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : ''
      }

      async function takePending() {
        for (const base of BASES) {
          try {
            const pending = await poll(base)
            if (pending !== undefined) return Object.assign({ base }, typeof pending === 'string' ? {} : pending)
          } catch {
            // Try the next path.
          }
        }
        return undefined
      }

      function ack(base, payload) {
        try {
          fetch(base + '/ack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true,
          }).catch(function () {})
        } catch {
          // Diagnostics only; never let them break the page.
        }
      }

      async function decide(base, call, action) {
        var answered = false
        var sessionId = ''
        var toolName = ''
        var reason = ''
        try {
          var pending = findApproval(ctx, call)
          if (pending) {
            sessionId = String(pending.sessionId || '')
            toolName = String(pending.toolName || '')
            reason = String(pending.reason || '')
            await pending.answer(action === 'deny' ? 'rejected' : 'allowed-once')
            answered = true
            if (action === 'allow-session' && sessionId) {
              sessionGrants[sessionId] = sessionGrants[sessionId] || {}
              sessionGrants[sessionId][grantKey(toolName, reason)] = true
            }
          }
        } catch (error) {
          console.warn('[session-toast] answering from the notification failed', error)
        }
        try {
          const response = await fetch(base + '/decide', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ call: call, action: action, sessionId: sessionId, toolName: toolName, reason: reason }),
            keepalive: true,
          })
          let applied = answered
          try {
            const body = await response.json()
            applied = applied || !!(body && body.ok)
          } catch {
            // Keep whatever the in-page answer told us.
          }
          ack(base, { action: action, call: call, ok: applied })
        } catch (error) {
          ack(base, { action: action, call: call, ok: answered })
          console.warn('[session-toast] approval answer failed', error)
        }
      }

      async function tick() {
        try {
          const hit = await takePending()
          if (hit && hit.action === 'answer' && hit.call && !stopped) {
            const outcome = await answerFromToast(ctx, hit.base, hit.call, hit.index, hit.step)
            const report = { call: hit.call, action: 'answer', ok: outcome.ok }
            if (!outcome.ok && outcome.error) report.error = outcome.error
            ack(hit.base, report)
          } else if (hit && hit.action && hit.call && !stopped) {
            await decide(hit.base, hit.call, hit.action)
          } else if (hit && hit.sessionId && !stopped) {
            try {
              await ctx.uiWorkspace.openSession(hit.sessionId)
              ack(hit.base, { sessionId: hit.sessionId, ok: true })
            } catch (error) {
              ack(hit.base, { sessionId: hit.sessionId, ok: false, error: String(error && error.message || error) })
              console.warn('[session-toast] openSession failed', error)
            }
          }
        } catch {
          // The host may be restarting; the next tick retries.
        }
        if (!stopped) timer = setTimeout(tick, INTERVAL_MS)
      }

      ctx.effect(() => () => {
        stopped = true
        clearTimeout(timer)
      })

      void tick()
    }

    // ---------------------------------------------------------------------
    // macOS: show the notification here, where the app owns it
    // ---------------------------------------------------------------------
    //
    // There is no way for a plain process on macOS to post a notification that
    // belongs to the app, so the host parks each notice in a queue and this half
    // claims it: a real notification, with a click that opens the conversation
    // and a sound played at the requested volume. When no page claims in time the
    // host posts it through osascript instead.

    function isMacBrowser() {
      try {
        return /Mac/i.test(String(navigator.platform || '') + ' ' + String(navigator.userAgent || ''))
      } catch {
        return false
      }
    }

    function startMacNotifier(ctx) {
      if (!isMacBrowser()) return
      if (typeof Notification !== 'function') {
        console.warn('[session-toast] this window cannot show notifications')
        return
      }
      if (typeof Notification.requestPermission === 'function') {
        try {
          Notification.requestPermission().catch(function () {})
        } catch {
          // Older Safari-style signatures take a callback; ignoring is fine.
        }
      }

      var stopped = false
      var timer
      var cursor = 0
      var base = BASES[0]

      async function claim(id) {
        var response = await fetch(base + '/inbox/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
          keepalive: true,
        })
        if (!response.ok) return null
        var body = await response.json()
        return body && body.item ? body.item : null
      }

      function play(base, item) {
        if (!item.sound || item.sound === 'silent' || !(item.volume > 0)) return
        try {
          var audio = new Audio(base + '/sound?name=' + encodeURIComponent(item.sound))
          audio.volume = Math.max(0, Math.min(1, Number(item.volume) / 100))
          var started = audio.play()
          if (started && typeof started.catch === 'function') started.catch(function () {})
        } catch (error) {
          console.warn('[session-toast] sound failed', error)
        }
      }

      function show(base, item) {
        var lines = Array.isArray(item.lines) ? item.lines : []
        var body = lines.slice(1).filter(function (line) { return line }).join(' · ')
        var notification
        try {
          notification = new Notification(String(lines[0] || 'DeepSeek Harness'), {
            body: body,
            silent: true,
            tag: String(item.sessionId || 'dsh-session-toast'),
          })
        } catch (error) {
          console.warn('[session-toast] notification failed', error)
          return
        }
        notification.onclick = function () {
          try {
            window.focus()
          } catch {
            // Focus is advisory.
          }
          if (item.clickToOpen && item.sessionId && ctx.uiWorkspace) {
            Promise.resolve()
              .then(function () { return ctx.uiWorkspace.openSession(item.sessionId) })
              .catch(function (error) { console.warn('[session-toast] openSession failed', error) })
          }
          try {
            notification.close()
          } catch {
            // Already gone.
          }
        }
        play(base, item)
      }

      async function tick() {
        try {
          var response = await fetch(base + '/inbox?since=' + cursor, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (response.ok) {
            var listing = await response.json()
            if (listing && Array.isArray(listing.items)) {
              for (var i = 0; i < listing.items.length && !stopped; i++) {
                var queued = listing.items[i]
                // Claim first so the host does not also post it via osascript.
                var item = await claim(queued.id)
                if (item) show(base, item)
                cursor = Math.max(cursor, Number(queued.id) || 0)
              }
            }
          }
        } catch {
          // The host may be restarting; the next tick retries.
        }
        if (!stopped) timer = setTimeout(tick, INTERVAL_MS)
      }

      ctx.effect(() => () => {
        stopped = true
        clearTimeout(timer)
      })

      void tick()
    }

    // ---------------------------------------------------------------------
    // Settings panel on the plugin page
    // ---------------------------------------------------------------------

    function registerSettings(ctx) {
      if (!React || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      // The full page, with the intro copy, lives on the plugin's own page.
      try {
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE,
            id: 'session-toast-settings',
            order: 10,
          }, SettingsPanel)
        })
      } catch (error) {
        console.warn('[session-toast] settings panel not registered', error)
      }
      // The settings dialog gets the same controls, minus the long description.
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'session-toast',
            order: 90,
            label: function () {
              return COPY.nav
            },
          }, SettingsSection)
        })
      } catch (error) {
        console.warn('[session-toast] settings section not registered', error)
      }
      // The settings nav draws one icon per section id; without this it falls
      // back to a generic gear. The id must match the section registered above.
      try {
        ctx.slots.inject('settings.section.icon', function () {
          return ctx.slots.register({
            name: 'settings.section.icon',
            id: 'session-toast',
            order: 90,
          }, NavBell)
        })
      } catch (error) {
        console.warn('[session-toast] settings icon not registered', error)
      }
    }

    /** The bell beside the settings nav row, drawn at the icon size the nav asks for. */
    function NavBell(props) {
      const size = (props && props.size) || 16
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', {
          d: 'M8 2.6a3.9 3.9 0 0 0-3.9 3.9v2.3c0 .8-.3 1.5-.8 2.1l-.6.7h10.6l-.6-.7c-.5-.6-.8-1.3-.8-2.1V6.5A3.9 3.9 0 0 0 8 2.6Z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        React.createElement('path', {
          d: 'M8 1.3v1.1',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M6.5 12.2h3a1.5 1.5 0 0 1-3 0Z',
          fill: 'currentColor',
        }),
      )
    }

    /** One settings row on the settings page: a heading, a hint, then the switches. */
    function SettingsSection() {
      // Follow the language the app settles on instead of the one it booted with.
      usePageLanguage()
      return React.createElement(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 24 } },
        React.createElement(
          'header',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          React.createElement(
            'h2',
            { style: { margin: 0, fontSize: 18, fontWeight: 600 } },
            COPY.sectionTitle,
          ),
          React.createElement(
            'p',
            { style: { margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.7 } },
            COPY.sectionHint,
          ),
        ),
        React.createElement(SettingsPanel),
      )
    }

    async function request(method, body) {
      for (const base of BASES) {
        try {
          const response = await fetch(base + '/settings', {
            method: method,
            headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            cache: 'no-store',
          })
          if (!response.ok) continue
          return await response.json()
        } catch {
          // Try the next path.
        }
      }
      throw new Error('settings route unavailable')
    }

    function preview(sound) {
      for (const base of BASES) {
        try {
          fetch(base + '/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sound: sound }),
          }).catch(function () {})
          return
        } catch {
          // Fall through to the next path.
        }
      }
    }

    /** Ask the host for a native audio-file picker; resolves to '' when cancelled. */
    async function pickFile() {
      for (const base of BASES) {
        try {
          const response = await fetch(base + '/pick', { method: 'POST', cache: 'no-store' })
          if (!response.ok) continue
          const body = await response.json()
          return body && body.path ? String(body.path) : ''
        } catch {
          // Try the next path.
        }
      }
      throw new Error('pick route unavailable')
    }

    function shortPath(path) {
      var text = String(path || '')
      var parts = text.split(/[\\/]/).filter(Boolean)
      return parts.length > 2 ? '…\\' + parts.slice(-2).join('\\') : text
    }

    function SettingsPanel() {
      // Same reason as the section above: the panel is mounted before DSH has
      // necessarily switched to the stored language.
      usePageLanguage()
      var store = React.useState(null)
      var snapshot = store[0]
      var setSnapshot = store[1]
      var statusStore = React.useState('loading')
      var status = statusStore[0]
      var setStatus = statusStore[1]
      var draftStore = React.useState({ name: '', path: '' })
      var draft = draftStore[0]
      var setDraft = draftStore[1]

      React.useEffect(function () {
        var alive = true
        request('GET')
          .then(function (body) {
            if (!alive || !body) return
            setSnapshot(body)
            setStatus('ready')
          })
          .catch(function () {
            if (alive) setStatus('failed')
          })
        return function () {
          alive = false
        }
      }, [])

      function save(patch) {
        if (!snapshot) return
        // Optimistic: the switch must move under the pointer. A rejected write
        // is rolled back below.
        var previous = snapshot.values
        var next = Object.assign({}, previous, patch)
        setSnapshot(Object.assign({}, snapshot, { values: next }))
        setStatus('saving')
        request('POST', patch)
          .then(function (body) {
            setSnapshot(body)
            setStatus('saved')
          })
          .catch(function () {
            setSnapshot(Object.assign({}, snapshot, { values: previous }))
            setStatus('failed')
          })
      }

      if (!snapshot) {
        return h('div', { style: styleNote }, COPY.loading)
      }

      var values = snapshot.values || {}
      var sounds = (snapshot.sounds && snapshot.sounds.length ? snapshot.sounds : ['default', 'reminder', 'silent'])
      var custom = values.customSounds && typeof values.customSounds === 'object' ? values.customSounds : {}
      // The taskbar blink is a Windows-only trick (user32 FlashWindowEx); on a Mac
      // browser the switch is shown disabled with a note instead of silently doing nothing.
      var macBrowser = isMacBrowser()

      function writeCustom(next) {
        save({ customSounds: next })
      }

      function addCustom() {
        var name = String(draft.name || '').trim()
        var path = String(draft.path || '').trim()
        if (!name || !path) {
          setStatus('failed')
          return
        }
        var next = Object.assign({}, custom)
        next[name] = path
        setDraft({ name: '', path: '' })
        writeCustom(next)
      }

      function removeCustom(name) {
        var next = Object.assign({}, custom)
        delete next[name]
        writeCustom(next)
      }

      function browse() {
        pickFile()
          .then(function (file) {
            if (!file) return
            var base = String(file).split(/[\\/]/).pop().replace(/\.(wav|mp3)$/i, '')
            setDraft({ name: draft.name || base, path: file })
          })
          .catch(function () {
            setStatus('failed')
          })
      }

      return h('div', { style: styleRoot },
        h('div', { style: styleHeading }, COPY.notify),
        row(COPY.turn, COPY.turnHint, Toggle({
          checked: values.notifyTurn !== false,
          onChange: function (next) { save({ notifyTurn: next }) },
        })),
        row(COPY.question, COPY.questionHint, Toggle({
          checked: values.notifyQuestions !== false,
          onChange: function (next) { save({ notifyQuestions: next }) },
        })),
        row(COPY.approval, COPY.approvalHint, Toggle({
          checked: values.notifyApprovals !== false,
          onChange: function (next) { save({ notifyApprovals: next }) },
        })),
        row(COPY.flash, macBrowser ? COPY.flashHintMac : COPY.flashHint, Toggle({
          checked: values.flashTaskbar !== false,
          disabled: macBrowser,
          onChange: function (next) { save({ flashTaskbar: next }) },
        })),

        h('div', { style: styleHeading }, COPY.behavior),
        row(COPY.reply, macBrowser ? COPY.replyHintMac : COPY.replyHint, Toggle({
          checked: values.replyInToast !== false,
          disabled: macBrowser,
          onChange: function (next) { save({ replyInToast: next }) },
        })),
        row(COPY.click, COPY.clickHint, Toggle({
          checked: values.clickToOpen !== false,
          onChange: function (next) { save({ clickToOpen: next }) },
        })),
        row(COPY.focus, COPY.focusHint, Toggle({
          checked: values.respectFocus !== false,
          onChange: function (next) { save({ respectFocus: next }) },
        })),
        row(COPY.goal, COPY.goalHint, Toggle({
          checked: values.suppressWhileGoal !== false,
          onChange: function (next) { save({ suppressWhileGoal: next }) },
        })),

        h('div', { style: styleHeading }, COPY.sound),
        row(COPY.soundComplete, COPY.soundHint, soundPicker(
          values.soundComplete,
          sounds,
          function (value) { save({ soundComplete: value }) },
        )),
        row(COPY.soundQuestion, COPY.soundHint, soundPicker(
          values.soundQuestion,
          sounds,
          function (value) { save({ soundQuestion: value }) },
        )),
        row(COPY.soundApproval, COPY.soundHint, soundPicker(
          values.soundApproval,
          sounds,
          function (value) { save({ soundApproval: value }) },
        )),

        h('div', { style: styleHeading }, COPY.customSounds),
        Object.keys(custom).map(function (name) {
          return row(name, shortPath(custom[name]), h('div', { style: styleCluster },
            h('button', {
              type: 'button',
              style: styleGhost,
              onClick: function () { preview('custom:' + name) },
            }, COPY.preview),
            h('button', {
              type: 'button',
              style: styleGhost,
              onClick: function () { removeCustom(name) },
            }, COPY.remove),
          ))
        }),
        row(COPY.addCustom, COPY.addCustomHint, h('div', { style: styleCluster },
          h('input', {
            value: draft.name,
            placeholder: COPY.soundName,
            onChange: function (event) { setDraft({ name: event.target.value, path: draft.path }) },
            style: styleInput,
          }),
          h('button', { type: 'button', style: styleGhost, onClick: browse }, COPY.browse),
          h('button', {
            type: 'button',
            style: styleGhost,
            disabled: !draft.name || !draft.path,
            onClick: addCustom,
          }, COPY.add),
        )),
        draft.path ? h('div', { style: styleNote }, draft.path) : null,

        h('div', { style: styleHeading }, COPY.volume),
        row(COPY.kindTurn, COPY.volumeHint, volumeSlider(values.volumeComplete, function (next) { save({ volumeComplete: next }) })),
        row(COPY.kindQuestion, COPY.volumeHint, volumeSlider(values.volumeQuestion, function (next) { save({ volumeQuestion: next }) })),
        row(COPY.kindApproval, COPY.volumeHint, volumeSlider(values.volumeApproval, function (next) { save({ volumeApproval: next }) })),

        h('div', { style: styleHeading }, COPY.quietTitle),
        quietNow(values).length > 0
          ? h('div', { style: styleQuietNow }, COPY.quietActive(quietNow(values).join(COPY.listJoin)))
          : null,
        row(COPY.kindTurn, COPY.quietHint, quietWindow(values.quietComplete, function (next) { save({ quietComplete: next }) })),
        row(COPY.kindQuestion, COPY.quietHint, quietWindow(values.quietQuestion, function (next) { save({ quietQuestion: next }) })),
        row(COPY.kindApproval, COPY.quietHint, quietWindow(values.quietApproval, function (next) { save({ quietApproval: next }) })),

        status === 'failed'
          ? h('div', { style: styleError }, COPY.failed)
          : h('div', { style: styleNote },
            status === 'saving' ? COPY.saving : status === 'saved' ? COPY.saved : COPY.auto),
      )
    }

    function soundPicker(value, sounds, onChange) {
      var current = typeof value === 'string' ? value : 'default'
      return h('div', { style: styleCluster },
        h('select', {
          value: current,
          onChange: function (event) { onChange(event.target.value) },
          style: styleSelect,
        }, sounds.map(function (id) {
          return h('option', { key: id, value: id }, labelFor(id))
        })),
        h('button', {
          type: 'button',
          onClick: function () { preview(current) },
          style: styleGhost,
        }, COPY.preview),
      )
    }

    function volumeSlider(value, onChange) {
      var current = typeof value === 'number' ? value : 100
      return h('div', { style: styleCluster },
        h('input', {
          type: 'range',
          min: 0,
          max: 100,
          step: 5,
          value: current,
          style: styleRange,
          'aria-label': COPY.volume,
          onChange: function (event) { onChange(Number(event.target.value)) },
        }),
        h('span', { style: styleMeter }, current + '%'),
      )
    }

    // A quiet window is one switch plus two time pickers. The switch writes the
    // default window, so turning it on works without touching the pickers.
    function quietWindow(value, onChange) {
      var text = typeof value === 'string' ? value.trim() : ''
      var match = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/.exec(text)
      var enabled = match !== null
      var from = enabled ? padHour(match[1]) + ':' + match[2] : QUIET_DEFAULT_FROM
      var to = enabled ? padHour(match[3]) + ':' + match[4] : QUIET_DEFAULT_TO
      // The switch keeps the same column in every row: the pickers sit in the
      // flexible middle and the switch is pushed to the right edge.
      return h('div', { style: styleQuietRow },
        enabled
          ? h('div', { style: styleCluster },
            timePicker(from, function (next) { onChange(next + '-' + to) }),
            h('span', { style: styleMeter }, '→'),
            timePicker(to, function (next) { onChange(from + '-' + next) }),
          )
          : null,
        h('div', { style: styleQuietSwitch },
          Toggle({
            checked: enabled,
            ariaLabel: COPY.quietTitle,
            onChange: function (next) { onChange(next ? QUIET_DEFAULT_FROM + '-' + QUIET_DEFAULT_TO : '') },
          }),
        ),
      )
    }

    function padHour(hour) {
      var text = String(hour)
      return text.length === 1 ? '0' + text : text
    }

    /** Minutes since midnight for "HH:MM", or -1 when the text is not a time. */
    function clockMinutes(text) {
      var match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim())
      if (!match) return -1
      return Number(match[1]) * 60 + Number(match[2])
    }

    /**
     * Is this window running right now? `from === to` means the switch is off,
     * and `from > to` wraps past midnight (22:00 → 08:00).
     */
    function windowRunningNow(range) {
      var parts = String(range || '').split('-')
      if (parts.length !== 2) return false
      var from = clockMinutes(parts[0])
      var to = clockMinutes(parts[1])
      if (from < 0 || to < 0 || from === to) return false
      var now = new Date()
      var minutes = now.getHours() * 60 + now.getMinutes()
      return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
    }

    /** The kinds whose quiet window covers this minute, for the note in the panel. */
    function quietNow(values) {
      var kinds = [
        { range: values.quietComplete, label: COPY.kindTurn },
        { range: values.quietQuestion, label: COPY.kindQuestion },
        { range: values.quietApproval, label: COPY.kindApproval },
      ]
      var running = []
      for (var i = 0; i < kinds.length; i += 1) {
        if (windowRunningNow(kinds[i].range)) running.push(kinds[i].label + ' ' + kinds[i].range.replace('-', '–'))
      }
      return running
    }

    function timePicker(value, onChange) {
      return h('select', {
        value: value,
        title: COPY.quietHint,
        style: styleTime,
        onChange: function (event) { onChange(event.target.value) },
      }, TIME_OPTIONS.map(function (slot) {
        return h('option', { key: slot, value: slot }, slot)
      }))
    }

    function labelFor(id) {
      if (String(id).indexOf('custom:') === 0) return COPY.customSoundPrefix + String(id).slice(7)
      return COPY.soundNames[id] || id
    }

    function Toggle(props) {
      var checked = props.checked !== false
      var disabled = props.disabled === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': props.ariaLabel,
        'aria-disabled': disabled ? 'true' : undefined,
        disabled: disabled || undefined,
        onClick: function () {
          if (disabled) return
          props.onChange(!checked)
        },
        style: {
          width: 36,
          height: 20,
          flex: '0 0 auto',
          padding: 0,
          position: 'relative',
          borderRadius: 999,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          border: '1px solid ' + (checked ? 'transparent' : 'rgba(128,128,128,0.45)'),
          background: checked ? '#3b82f6' : 'rgba(128,128,128,0.16)',
          transition: 'background 0.15s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 14,
          height: 14,
          borderRadius: 7,
          background: checked ? '#fff' : 'rgba(128,128,128,0.75)',
          transition: 'left 0.15s ease',
        },
      }))
    }

    function row(label, hint, control) {
      return h('div', { style: styleRow },
        h('div', { style: styleLabel },
          h('div', null, label),
          hint ? h('div', { style: styleHint }, hint) : null,
        ),
        control,
      )
    }

    var styleRoot = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13 }
    var styleHeading = {
      marginTop: 14,
      marginBottom: 4,
      fontSize: 12,
      fontWeight: 600,
      opacity: 0.55,
      letterSpacing: 0.3,
    }
    var styleRow = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '8px 0',
      borderBottom: '1px solid rgba(128,128,128,0.18)',
    }
    var styleLabel = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
    var styleHint = { fontSize: 11.5, opacity: 0.55, lineHeight: 1.35 }
    var styleCluster = { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }
    var styleSelect = {
      font: 'inherit',
      fontSize: 12,
      color: 'inherit',
      background: 'rgba(128,128,128,0.12)',
      border: '1px solid rgba(128,128,128,0.3)',
      borderRadius: 8,
      padding: '3px 6px',
      cursor: 'pointer',
    }
    var styleGhost = {
      font: 'inherit',
      fontSize: 12,
      color: 'inherit',
      background: 'transparent',
      border: '1px solid rgba(128,128,128,0.3)',
      borderRadius: 8,
      padding: '3px 8px',
      cursor: 'pointer',
    }
    var styleNote = { marginTop: 10, fontSize: 11.5, opacity: 0.5 }
    var styleError = { marginTop: 10, fontSize: 11.5, color: '#e5534b' }
    var styleInput = {
      font: 'inherit',
      fontSize: 12,
      color: 'inherit',
      background: 'rgba(128,128,128,0.1)',
      border: '1px solid rgba(128,128,128,0.3)',
      borderRadius: 8,
      padding: '3px 6px',
      width: 120,
    }
    var styleRange = { width: 96, accentColor: '#3b82f6' }
    var styleMeter = { fontSize: 11.5, opacity: 0.6, minWidth: 32, textAlign: 'right' }
    var styleQuiet = {
      font: 'inherit',
      fontSize: 12,
      color: 'inherit',
      background: 'rgba(128,128,128,0.1)',
      border: '1px solid rgba(128,128,128,0.3)',
      borderRadius: 8,
      padding: '3px 6px',
      width: 108,
    }
    var styleQuietRow = { display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 auto', minWidth: 0 }
    var styleQuietSwitch = { marginLeft: 'auto', display: 'flex', alignItems: 'center' }
    var styleQuietNow = { marginTop: 2, marginBottom: 6, fontSize: 11.5, lineHeight: 1.5, color: '#d97706' }
    var styleTime = {
      font: 'inherit',
      fontSize: 12,
      color: 'inherit',
      background: 'rgba(128,128,128,0.1)',
      border: '1px solid rgba(128,128,128,0.3)',
      borderRadius: 8,
      padding: '3px 4px',
      width: 78,
    }

    function detectZh() {
      try {
        var lang = String(document.documentElement && document.documentElement.lang || '').toLowerCase()
        if (lang) return lang.indexOf('zh') === 0
        var first = String((navigator.languages && navigator.languages[0]) || navigator.language || '')
        if (first) return first.toLowerCase().indexOf('zh') === 0
        return String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().indexOf('zh') === 0
      } catch {
        return true
      }
    }

    var ZH = {
      nav: '弹窗提醒',
      sectionTitle: '会话事件弹窗提醒',
      sectionHint: '这里只有开关和提示音；完整说明、通知样例和实现细节在「插件 → 会话事件弹窗提醒」的页面里。',
      notify: '通知',
      sound: '提示音',
      turn: '会话完成时弹窗',
      turnHint: '一轮回复结束时提醒',
      question: '中途提问时弹窗',
      questionHint: 'agent 需要你回答时提醒',
      approval: '等待授权时弹窗',
      approvalHint: '工具调用需要批准时提醒',
      flash: '任务栏图标闪烁',
      flashHint: '弹窗同时闪烁任务栏，直到窗口回到前台（仅 Windows）',
      flashHintMac: '仅 Windows 支持：macOS 不允许一个应用去闪烁别的应用的窗口，这个开关在 macOS 上不生效',
      click: '点击通知返回该会话',
      clickHint: '关闭后通知只是提示，不再跳转',
      soundComplete: '完成提示音',
      soundQuestion: '提问提示音',
      soundApproval: '授权提示音',
      soundHint: '试听一次，立即生效',
      behavior: '行为',
      reply: '弹窗内回复',
      replyHint: '通知里带上提问正文和它的选项，授权通知带「允许一次 / 拒绝」两个按钮（和卡片一致）；关掉则通知只提示，回到会话里再回',
    replyHintMac: '仅 Windows 支持：macOS 的系统通知没有按钮，mac 上只做简单提醒',
      focus: '当前会话已在前台时不打扰',
      focusHint: '只跳过你正开着的那个会话，其他会话照常弹',
      goal: 'goal 连续多轮只提醒一次',
      goalHint: 'goal 模式会自动接着跑，逐轮弹会刷屏',
      volume: '音量',
      quietTitle: '静音时段',
      volumeHint: '每种提示单独设音量',
      kindTurn: '完成通知',
      kindQuestion: '提问通知',
      kindApproval: '授权通知',
      quietHint: '开启后这段时间不响，默认 22:00 → 08:00；跨午夜也支持',
      quietActive: function (list) { return '现在正处于静音时段（' + list + '），这段时间不响' },
      listJoin: '、',
      customSounds: '自定义提示音',
      customSoundPrefix: '自定义：',
      addCustom: '添加提示音',
      addCustomHint: '选一个 .wav 或 .mp3 并命名，就能在上面三个下拉里选到',
      soundName: '名称',
      browse: '选择文件',
      add: '添加',
      remove: '删除',
      preview: '试听',
      loading: '读取设置…',
      saving: '保存中…',
      saved: '已保存，立即生效',
      auto: '改动会立即生效',
      failed: '设置服务不可用，请确认插件已启用并刷新页面',
      soundNames: {
        default: '默认',
        reminder: '提醒',
        mail: '邮件',
        silent: '无声',
        'terminal-bell': '终端响铃',
        'edits-undone': '编辑撤回',
        'zcode-pop': 'ZCode 弹窗',
        'apple-sms': '苹果短信',
        'apple-received': '苹果来信',
        'apple-sent': '苹果发送',
        success: '成功',
        'task-completed': '任务完成',
      },
    }

    var EN = {
      nav: 'Popups',
      sectionTitle: 'Session event popup',
      sectionHint: 'Only switches and sounds here; the full write-up with notification samples lives on the Plugins page for this bundle.',
      notify: 'Notifications',
      sound: 'Sounds',
      turn: 'Popup when a turn finishes',
      turnHint: 'Remind me once the reply is done',
      question: 'Popup when the agent asks',
      questionHint: 'Remind me when an answer is needed',
      approval: 'Popup while approval is pending',
      approvalHint: 'Remind me when a tool call needs a decision',
      flash: 'Blink the taskbar icon',
      flashHint: 'Flash the taskbar button too, until the window comes forward (Windows only)',
      flashHintMac: 'Windows only: macOS does not let one app flash another app\'s window, so this switch does nothing on macOS',
      click: 'Click a notification to open that session',
      clickHint: 'Off leaves the notification informational only',
      soundComplete: 'Turn-finished sound',
      soundQuestion: 'Question sound',
      soundApproval: 'Approval sound',
      soundHint: 'Preview once; changes apply immediately',
      behavior: 'Behavior',
      reply: 'Reply right in the popup',
      replyHint: 'Puts the question and its options in the notice, and gives an approval the same two buttons the card has (allow once / deny); off leaves it informational and you answer in the app',
    replyHintMac: 'Windows only: macOS notifications carry no buttons, so the app only reminds you there',
      focus: 'Stay quiet for the conversation on screen',
      focusHint: 'Only the open session is skipped; every other session still pops',
      goal: 'One reminder per goal, not per round',
      goalHint: 'Goal mode keeps continuing by itself, so every round would spam',
      volume: 'Volume',
      quietTitle: 'Quiet hours',
      volumeHint: 'Each notice has its own level',
      kindTurn: 'Finish notice',
      kindQuestion: 'Question notice',
      kindApproval: 'Approval notice',
      quietHint: 'Turn it on to stay silent in that window; defaults to 22:00 → 08:00 and crosses midnight',
      quietActive: function (list) { return 'Quiet hours are active right now (' + list + ') - those notices stay silent' },
      listJoin: ', ',
      customSounds: 'Custom sounds',
      customSoundPrefix: 'Custom: ',
      addCustom: 'Add a sound',
      addCustomHint: 'Pick a .wav or .mp3, name it, and it becomes selectable above',
      soundName: 'Name',
      browse: 'Choose file',
      add: 'Add',
      remove: 'Remove',
      preview: 'Preview',
      loading: 'Reading settings…',
      saving: 'Saving…',
      saved: 'Saved, applied immediately',
      auto: 'Changes apply immediately',
      failed: 'Settings service unavailable — enable the plugin and reload the page',
      soundNames: {
        default: 'Default',
        reminder: 'Reminder',
        mail: 'Mail',
        silent: 'Silent',
        'terminal-bell': 'Terminal bell',
        'edits-undone': 'Edits undone',
        'zcode-pop': 'ZCode pop',
        'apple-sms': 'Apple SMS',
        'apple-received': 'Apple received',
        'apple-sent': 'Apple sent',
        success: 'Success',
        'task-completed': 'Task complete',
      },
    }

    var COPY = detectZh() ? ZH : EN

    /** The locale service of this page, when the frame it runs in has one. */
    var localeRuntime = null

    /** The locale id the app is actually showing right now, '' when unknown. */
    function activeLocaleId() {
      try {
        if (localeRuntime && typeof localeRuntime.getSnapshot === 'function') {
          var snapshot = localeRuntime.getSnapshot()
          var active = snapshot && snapshot.active
          if (active) return String(active)
        }
      } catch {
        // Fall through to the document.
      }
      return ''
    }

    /**
     * The locale service knows the stored preference; the document only knows
     * what the page got at boot. Both are consulted, the service first.
     */
    function prefersChinese() {
      var active = activeLocaleId().toLowerCase()
      if (active) return active.indexOf('zh') === 0
      return detectZh()
    }

    /**
     * The window can still be in English while DSH boots and only switch to the
     * chosen language a moment later, so the panel has to follow the page
     * instead of freezing whatever the document said at module load.
     */
    function refreshCopy() {
      var next = prefersChinese() ? ZH : EN
      if (next === COPY) return false
      COPY = next
      return true
    }

    /** Re-render whenever the language the app shows changes. */
    function usePageLanguage() {
      var state = React.useState(0)
      var bump = state[1]
      React.useEffect(function () {
        var disposed = false
        function update() {
          if (disposed) return
          if (refreshCopy()) bump(function (value) { return value + 1 })
        }
        var off
        try {
          if (localeRuntime && typeof localeRuntime.subscribe === 'function') {
            off = localeRuntime.subscribe(update)
          }
        } catch {
          // The observer and timer below still catch the change.
        }
        var observer
        try {
          if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(update)
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          }
        } catch {
          // No observer here; the timer below still catches the change.
        }
        // A last-resort poll: some shells change the language without emitting
        // anything we can observe. Guarded because tests run in a bare sandbox.
        var timer = null
        try {
          timer = setInterval(update, 1500)
        } catch {
          timer = null
        }
        try {
          window.addEventListener('languagechange', update)
        } catch {
          // Older engines only fire on window.
        }
        update()
        return function () {
          disposed = true
          try {
            if (typeof off === 'function') off()
          } catch {
            // Already unsubscribed.
          }
          if (timer !== null) clearInterval(timer)
          try { observer && observer.disconnect() } catch {}
          try { window.removeEventListener('languagechange', update) } catch {}
        }
      }, [])
    }

    return module.exports
  },
})
