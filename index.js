// Windows toast notifications for DSH sessions.
//
// Host plugin. It watches the durable `agent/status` transition
// (running -> idle) and the interactive seams (`user-questions/request`,
// `approval/request`), then pops a native Windows notification through Windows
// PowerShell 5.1 + WinRT. Every notification carries the session title,
// working directory and turn outcome so parallel sessions stay
// distinguishable, and clicking one jumps straight back to that session.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const REG = 'C:\\Windows\\System32\\reg.exe'
const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe'
const HERE = dirname(fileURLToPath(import.meta.url))
const TOAST_SCRIPT = join(HERE, 'toast.ps1')
const JUMP_SCRIPT = join(HERE, 'jump.ps1')
// A URL handler starts from Explorer, where a console program flashes a black
// window before it manages to hide itself. wscript is a GUI process, so it can
// start PowerShell hidden and the click stays silent.
const LAUNCH_SCRIPT = join(HERE, 'launch.vbs')

/** Custom protocol the toast activates; its handler records the target session. */
const PROTOCOL = 'dsh-session-toast'
/**
 * Where the browser half asks "which session was clicked?". Versioned because a
 * plugin upgrade leaves the previous module generation registered on the old
 * path until DSH restarts, and two generations cannot own the same prefix.
 */
const ROUTE = '/dsh-session-toast-v2'
/** Path used before 1.1.0; the client still falls back to it. */
const LEGACY_ROUTE = '/dsh-session-toast'
const PENDING_FILE = join(tmpdir(), 'dsh-session-toast-pending.txt')
/**
 * Process-wide slot holding the newest click handler. The web server refuses a
 * second handler on the same path, so every generation after the first one
 * would otherwise keep answering with its own (older) code.
 */
const ROUTE_SLOT = Symbol.for('dsh-session-toast.handler')
/** Buttons a toast can carry; anything else in the pending file is ignored. */
const PENDING_ACTIONS = new Set(['allow', 'allow-session', 'deny', 'answer'])

/**
 * Switches the plugin page writes. They live beside the profile's other plugin
 * state instead of inside the package, so re-checking out the plugin checkout
 * does not reset what the user picked.
 */
const STORE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'session-toast', 'settings.json')

/** Maximum characters of the final answer shown in the notification body. */
const SNIPPET_LIMIT = 110
/**
 * A Windows toast renders at most three text elements and each one is one row,
 * so a line that overflows is dropped entirely instead of wrapping.
 */
const NOTIFY_LINES = 3
/** Toast buttons clip their label, so option labels are kept short. */
const QUESTION_LABEL_LIMIT = 12
/** Upper bound on remembered per-session state before the oldest entries go. */
const STATE_LIMIT = 200

const DEFAULTS = {
  appId: 'com.deepseek.dsh',
  /**
   * Which notification backend to use. Defaults to the running platform; the
   * config key exists so the test harness can exercise the macOS path on
   * Windows.
   */
  platform: process.platform,
  language: 'auto',
  includeSubagents: false,
  snippet: true,
  notifyTurn: true,
  soundComplete: 'default',
  soundQuestion: 'reminder',
  soundApproval: 'reminder',
  notifyQuestions: true,
  notifyApprovals: true,
  /** Blink the taskbar button of this window while a notification is shown. */
  flashTaskbar: true,
  /**
   * Let the user answer from the notification itself: the question text and its
   * options go into the notice, and approvals get allow once / allow for this
   * session / deny buttons.
   */
  replyInToast: true,
  /** Stay quiet for the conversation the user is looking at right now. */
  respectFocus: true,
  /** How long the approval toast may hold a request before the app takes it. */
  approvalTimeoutMs: 180000,
  /** A running goal continues by itself, so only its final round is announced. */
  suppressWhileGoal: true,
  /** Playback level per notification kind, 0 mutes that kind. */
  volumeComplete: 100,
  volumeQuestion: 100,
  volumeApproval: 100,
  /** Per-kind mute window as `HH:MM-HH:MM`, empty means no window. */
  quietComplete: '',
  quietQuestion: '',
  quietApproval: '',
  /** Extra sounds named by the user, `{ name: 'C:\\path\\sound.wav' }`. */
  customSounds: {},
  clickToOpen: true,
  minDurationMs: 0,
  debug: false,
  debugLog: join(tmpdir(), 'dsh-session-toast.log'),
}

/** Windows notification sounds; the panel only offers the first three. */
const SOUNDS = {
  default: 'ms-winsoundevent:Notification.Default',
  reminder: 'ms-winsoundevent:Notification.Reminder',
  mail: 'ms-winsoundevent:Notification.Mail',
}

/** Retired ids stay resolvable so saved settings keep working. */
const LEGACY_SOUNDS = {
  sms: 'ms-winsoundevent:Notification.SMS',
  im: 'ms-winsoundevent:Notification.IM',
  alarm: 'ms-winsoundevent:Notification.Looping.Alarm',
}

/**
 * Sounds shipped with the package, played back as files because Windows only
 * offers its own chimes through the notification API.
 */
const PACK_SOUNDS = {
  'terminal-bell': 'terminal-bell.mp3',
  'edits-undone': 'edits-undone.mp3',
  'zcode-pop': 'zcode-pop.mp3',
  'apple-sms': 'apple-sms.mp3',
  'apple-received': 'apple-received.mp3',
  'apple-sent': 'apple-sent.mp3',
  success: 'success.mp3',
  'task-completed': 'task-completed.mp3',
}

const SOUND_DIR = join(HERE, 'sounds')

/**
 * macOS has no WinRT toast, so the three system sounds map onto files the
 * system already ships; everything else is played from the package.
 */
const MAC_SOUNDS = {
  default: '/System/Library/Sounds/Glass.aiff',
  reminder: '/System/Library/Sounds/Ping.aiff',
  mail: '/System/Library/Sounds/Submarine.aiff',
}

/** How long a notification waits for a live page before osascript takes over. */
const MAC_FALLBACK_MS = 5_000

/** Where macOS keeps the shell tools this half relies on. */
const OSASCRIPT = '/usr/bin/osascript'
const AFPLAY = '/usr/bin/afplay'

const STRINGS = {
  zh: {
    completed: '✅ 会话完成',
    aborted: '⏹ 会话已中止',
    blocked: '⏸️ 会话已阻塞',
    error: '❌ 会话出错',
    'max-tokens': '⚠️ 已到输出上限',
    interrupted: '🔌 会话被中断',
    finished: '🔔 会话已结束',
    question: '❓ 需要回答',
    approval: '🔐 等待授权',
    goalDone: '🎯 目标完成',
    goalBlocked: '⛔ 目标受阻',
    allowOnce: '允许一次',
    allowSession: '本次会话允许',
    deny: '拒绝',
    options: '选项',
    answerNeeded: '等你回答',
    questionCount: (count) => `共 ${count} 个问题`,
    questionStep: (step, total) => `第 ${step}/${total} 题`,
    answerInApp: '这组问题要逐个填，回到会话里回答',
    untitled: '未命名会话',
    preview: '🔔 提示音试听',
    previewDetail: '会话事件弹窗提醒 · 设置',
    duration: (text) => `耗时 ${text}`,
    folder: (text) => `目录 ${text}`,
  },
  en: {
    completed: '✅ Session finished',
    aborted: '⏹ Session stopped',
    blocked: '⏸️ Session blocked',
    error: '❌ Session failed',
    'max-tokens': '⚠️ Output limit reached',
    interrupted: '🔌 Session interrupted',
    finished: '🔔 Session ended',
    question: '❓ Needs your answer',
    approval: '🔐 Waiting for approval',
    goalDone: '🎯 Goal complete',
    goalBlocked: '⛔ Goal blocked',
    allowOnce: 'Allow once',
    allowSession: 'Allow for this session',
    deny: 'Deny',
    options: 'Options',
    answerNeeded: 'Waiting for your answer',
    questionCount: (count) => `${count} questions`,
    questionStep: (step, total) => `question ${step} of ${total}`,
    answerInApp: 'This batch is filled in one by one; answer it in the app',
    untitled: 'Untitled session',
    preview: '🔔 Sound preview',
    previewDetail: 'Session toast · settings',
    duration: (text) => `took ${text}`,
    folder: (text) => `in ${text}`,
  },
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined || value === null) continue
      if (key === 'sound') {
        // Legacy `sound: false` still means "no sound anywhere".
        if (value === false) {
          settings.soundComplete = 'silent'
          settings.soundQuestion = 'silent'
          settings.soundApproval = 'silent'
        }
        continue
      }
      settings[key] = value
    }
  }
  const language = resolveLanguage(settings.language)
  const strings = STRINGS[language]

  // Switches written by the plugin page win over the patch: the page is the
  // place a user is expected to change them, and it must take effect at once.
  /** Keys the settings panel owns and may persist. */
  const PANEL_KEYS = [
    'notifyTurn', 'notifyQuestions', 'notifyApprovals', 'flashTaskbar', 'clickToOpen',
    'respectFocus', 'replyInToast', 'suppressWhileGoal',
    'soundComplete', 'soundQuestion', 'soundApproval', 'customSounds',
    'volumeComplete', 'volumeQuestion', 'volumeApproval',
    'quietComplete', 'quietQuestion', 'quietApproval',
  ]
  /** Panel keys that hold a sound name rather than a switch. */
  const SOUND_KEYS = new Set(['soundComplete', 'soundQuestion', 'soundApproval'])
  /** Panel keys that hold a switch. */
  const BOOL_KEYS = new Set([
    'notifyTurn', 'notifyQuestions', 'notifyApprovals', 'flashTaskbar', 'clickToOpen',
    'respectFocus', 'replyInToast', 'suppressWhileGoal',
  ])
  /** Panel keys that hold a playback level from 0 to 100. */
  const VOLUME_KEYS = new Set(['volumeComplete', 'volumeQuestion', 'volumeApproval'])
  /** Panel keys that hold a mute window, empty when the window is off. */
  const QUIET_KEYS = new Set(['quietComplete', 'quietQuestion', 'quietApproval'])
  const QUIET_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/
  const store = pickStore(readStore())
  mergeStore(store)

  // Where the user is looking, as reported by the client half. It exists only
  // to keep the conversation already on screen from chiming at itself; every
  // other session still gets its toast.
  const presence = { sessionId: '', focused: false, at: 0 }

  // macOS has no equivalent of a WinRT toast a plain process may post, so the
  // notification travels to the page first: there it is a real notification
  // owned by the app, and a click can open the conversation. When no page picks
  // it up in time, this half falls back to osascript.
  const isMac = String(settings.platform || process.platform) === 'darwin'
  const inbox = { nextId: 1, items: [] }

  function updatePresence(body) {
    const id = String(body?.sessionId || '')
    presence.sessionId = id
    presence.focused = body?.focused === true
    presence.at = Date.now()
    report(`presence session=${id || 'none'} focused=${presence.focused}`)
  }

  /** True when this exact conversation is on screen and focused right now. */
  function watching(sessionId) {
    if (settings.respectFocus === false || !sessionId) return false
    if (presence.sessionId !== sessionId || !presence.focused) return false
    return Date.now() - presence.at < 120_000
  }

  /** Playback level for one kind of notification. */
  function volumeFor(kind) {
    const key = kind === 'question' ? 'volumeQuestion' : kind === 'approval' ? 'volumeApproval' : 'volumeComplete'
    const level = Number(settings[key])
    return Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : 100
  }

  /** True when the clock is inside this kind's mute window. */
  function inQuietWindow(kind) {
    const key = kind === 'question' ? 'quietQuestion' : kind === 'approval' ? 'quietApproval' : 'quietComplete'
    const window = String(settings[key] || '').trim()
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window)
    if (!match) return false
    const now = new Date()
    const minutes = now.getHours() * 60 + now.getMinutes()
    const from = Number(match[1]) * 60 + Number(match[2])
    const to = Number(match[3]) * 60 + Number(match[4])
    if (from === to) return false
    // A window that ends before it starts wraps over midnight.
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  }

  function pickStore(value) {
    const picked = {}
    if (!value || typeof value !== 'object') return picked
    for (const key of PANEL_KEYS) {
      const entry = value[key]
      // A key the file does not mention keeps whatever the patch config set.
      if (entry === undefined) continue
      if (key === 'customSounds') {
        const sounds = pickCustomSounds(entry)
        if (sounds) picked.customSounds = sounds
        continue
      }
      if (SOUND_KEYS.has(key)) {
        if (typeof entry === 'string' && entry.length > 0 && entry.length <= 60) picked[key] = entry
        continue
      }
      if (BOOL_KEYS.has(key)) {
        if (typeof entry === 'boolean') picked[key] = entry
        continue
      }
      if (VOLUME_KEYS.has(key)) {
        const level = Number(entry)
        if (Number.isFinite(level)) picked[key] = Math.max(0, Math.min(100, Math.round(level)))
        continue
      }
      if (QUIET_KEYS.has(key)) {
        const window = String(entry ?? '').trim()
        if (window === '') picked[key] = ''
        else if (QUIET_PATTERN.test(window)) picked[key] = window
        continue
      }
      if (typeof entry === 'boolean') picked[key] = entry
    }
    return picked
  }

  function mergeStore(value) {
    for (const [key, entry] of Object.entries(value)) settings[key] = entry
  }

  function panelSnapshot() {
    const snapshot = {}
    for (const key of PANEL_KEYS) {
      snapshot[key] = key === 'customSounds'
        ? { ...(settings.customSounds || {}) }
        : settings[key]
    }
    return snapshot
  }

  /** Every sound the panel may offer: shipped files first, then the user's own. */
  function soundChoices() {
    const custom = settings.customSounds && typeof settings.customSounds === 'object' ? settings.customSounds : {}
    return [
      ...Object.keys(SOUNDS),
      'silent',
      ...Object.keys(PACK_SOUNDS).filter((id) => existsSync(join(SOUND_DIR, PACK_SOUNDS[id]))),
      ...Object.keys(custom).map((name) => `custom:${name}`),
    ]
  }

  async function updatePanel(patch) {
    const picked = pickStore(patch)
    if (Object.keys(picked).length === 0) return false
    Object.assign(store, picked)
    mergeStore(picked)
    await writeStore(store)
    report(`settings ${JSON.stringify(picked)}`)
    return true
  }

  /** Turn start time per agent id, so a finished turn has a measurable span. */
  const started = new Map()
  /** Latest turn outcome per session id, filled by `session/event`. */
  const turns = new Map()
  /** First user prompt per session id, used when no title was generated yet. */
  const prompts = new Map()
  /** Latest goal phase per session id, filled by `session/event`. */
  const goals = new Map()
  /** Approvals this plugin holds while the toast waits for a button press. */
  const claims = new Map()
  /**
   * Grants made from a toast button: session id -> Set of `<tool>|<reason>`
   * signatures. DSH only has one approval policy per agent and its outcomes are
   * allow-once or reject, so "allow for this session" is remembered here and
   * answered by this plugin instead of asking again.
   */
  const sessionAllows = new Map()
  /** callId -> the question card a click may walk through, question by question. */
  const questionCards = new Map()

  const allowSignature = (toolName, reason) => `${String(toolName || '')}|${String(reason || '')}`

  function sessionAllowsRequest(sessionId, toolName, reason) {
    const granted = sessionAllows.get(sessionId)
    return Boolean(granted && granted.has(allowSignature(toolName, reason)))
  }

  function rememberSessionAllow(sessionId, toolName, reason) {
    if (!sessionId) return
    const granted = sessionAllows.get(sessionId) || new Set()
    granted.add(allowSignature(toolName, reason))
    sessionAllows.set(sessionId, granted)
    if (sessionAllows.size > STATE_LIMIT) {
      const oldest = sessionAllows.keys().next()
      if (!oldest.done) sessionAllows.delete(oldest.value)
    }
  }

  const log = (message) => {
    if (!settings.debug) return
    appendLine(settings.debugLog, message)
  }
  const report = (note) => log(`${new Date().toISOString()} ${note}`)

  const remember = (id, patch) => {
    const entry = turns.get(id) || {}
    turns.set(id, { ...entry, ...patch })
    if (turns.size > STATE_LIMIT) {
      const oldest = turns.keys().next()
      if (!oldest.done) turns.delete(oldest.value)
    }
  }

  /**
   * Requests already announced, so one request that reaches us through both the
   * session log and the waterfall seam still rings once. Keyed by session plus
   * request id; a minute of memory is enough for both seams to agree.
   */
  const announced = new Map()
  const ANNOUNCE_WINDOW_MS = 60_000

  function announce(key) {
    const now = Date.now()
    const seen = announced.get(key)
    if (seen !== undefined && now - seen < ANNOUNCE_WINDOW_MS) return false
    announced.set(key, now)
    if (announced.size > STATE_LIMIT) {
      const oldest = announced.keys().next()
      if (!oldest.done) announced.delete(oldest.value)
    }
    return true
  }

  /** The question batch out of a logged `ask_user_question` argument value. */
  function questionsOf(raw) {
    let value = raw
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return []
      }
    }
    const items = Array.isArray(value?.questions) ? value.questions : []
    return items.filter((item) => item && typeof item === 'object')
  }

  // Once the web bridge has claimed `user-questions/request`, the logged
  // `tool/call` payload is the only place the batch is still readable, so the
  // arguments are looked for under every field name the log has used.
  function questionsFromCall(data) {
    if (!data || typeof data !== 'object') return []
    const candidates = [data.arguments, data.input, data.args, data.params, data.toolArguments]
    for (const candidate of candidates) {
      const items = questionsOf(candidate)
      if (items.length > 0) return items
    }
    if (Array.isArray(data.questions)) return data.questions.filter((item) => item && typeof item === 'object')
    if (settings.debug) {
      const shape = Object.keys(data).map((key) => {
        const value = data[key]
        if (typeof value === 'string') return `${key}=string:${value.length}`
        if (Array.isArray(value)) return `${key}=array:${value.length}`
        if (value && typeof value === 'object') return `${key}=object:{${Object.keys(value).join('|')}}`
        return `${key}=${typeof value}`
      })
      report(`tool/call shape ${shape.join(' ')}`)
    }
    return []
  }

  function questionLines(session, agent, items, step) {
    const list = Array.isArray(items) ? items : []
    const total = list.length
    const at = Math.min(Math.max(Number(step) || 0, 0), Math.max(total - 1, 0))
    const current = list[at] || list[0]
    const title = session ? titleOf(session, agent) : strings.untitled
    const folder = shortenDirectory(session?.header?.cwd)
    const header = String(current?.header || '').trim()
    const ask = String(current?.question || '').trim()
    const options = optionLabels(current)
    const head = total > 1
      ? `${strings.question} · ${title} (${strings.questionStep(at + 1, total)})`
      : `${strings.question} · ${title}`
    // A Windows toast renders at most three text elements (each one wraps
    // instead of being cut), so the folder only shows up when the body does not.
    const lines = [head]
    if (settings.replyInToast === false) {
      if (folder) lines.push(strings.folder(folder))
      if (header) lines.push(truncate(clean(header), SNIPPET_LIMIT))
      return lines.slice(0, NOTIFY_LINES)
    }
    const body = [header ? clean(header) : '', ask ? clean(ask) : ''].filter(Boolean).join(' · ')
    if (body) lines.push(truncate(body, SNIPPET_LIMIT))
    else if (folder) lines.push(strings.folder(folder))
    if (options.length > 0) lines.push(`${strings.options}：${truncate(clean(options.join(' / ')), SNIPPET_LIMIT)}`)
    else lines.push(total > 1 ? strings.answerInApp : strings.answerNeeded)
    return lines.slice(0, NOTIFY_LINES)
  }

  function optionLabels(item) {
    const options = Array.isArray(item?.options) ? item.options : []
    return options.map((option) => String(option?.label || '').trim()).filter(Boolean)
  }

  /**
   * A batch is answered one question at a time: every question has to be
   * pickable from a button, because the toast walks through them in order and
   * only submits once the last one is picked.
   */
  function clicksAnswerable(items) {
    const list = Array.isArray(items) ? items : []
    if (list.length === 0) return false
    return list.every((item) => optionLabels(item).length > 0)
  }

  function announceQuestion(session, agent, items, sessionId, callId) {
    if (settings.notifyQuestions === false) return
    if (watching(sessionId)) {
      report(`skip focused question session=${sessionId || '-'}`)
      return
    }
    const list = Array.isArray(items) ? items.slice(0, 12) : []
    // Keep the card around so a click can move the toast on to the next
    // question of a batch without asking the page again.
    if (callId && list.length > 0) {
      questionCards.set(callId, {
        sessionId,
        items: list,
        total: list.length,
        linesFor: (step) => questionLines(session, agent, list, step),
        at: Date.now(),
      })
      if (questionCards.size > STATE_LIMIT) questionCards.delete(questionCards.keys().next().value)
    }
    const actions = settings.replyInToast !== false && settings.clickToOpen !== false && callId
      && clicksAnswerable(list)
      ? questionActions(callId, list, 0)
      : []
    notify('question', sessionId, questionLines(session, agent, list, 0), settings.soundQuestion,
      actions.length > 0 ? { actions } : undefined)
  }

  /**
   * One button per option of the question currently being asked. Windows shows
   * at most a handful, so three are offered. The step in the arguments tells the
   * page which question of a batch the click belongs to.
   */
  function questionActions(callId, items, step) {
    const list = Array.isArray(items) ? items : []
    const at = Math.min(Math.max(Number(step) || 0, 0), Math.max(list.length - 1, 0))
    const current = list[at]
    const options = optionLabels(current)
    if (options.length === 0) return []
    const id = encodeURIComponent(callId)
    return options.slice(0, 3).map((label, index) => ({
      label: truncate(clean(label), QUESTION_LABEL_LIMIT),
      activationType: 'protocol',
      arguments: `${PROTOCOL}:?action=answer&call=${id}&index=${index}&step=${at}`,
    })).filter((action) => action.label !== '')
  }

  function approvalLines(session, toolName, reason) {
    const title = titleOf(session)
    const folder = shortenDirectory(session?.header?.cwd)
    const lines = [`${strings.approval} · ${title}`]
    if (folder) lines.push(strings.folder(folder))
    const detail = [String(toolName || ''), String(reason || '')].filter(Boolean).join(' · ')
    if (detail) lines.push(truncate(clean(detail), SNIPPET_LIMIT))
    return lines
  }

  function notifyApproval(session, toolName, reason, extra) {
    const sessionId = String(session?.id || '')
    if (settings.notifyApprovals === false) return
    if (watching(sessionId)) {
      report(`skip focused approval session=${sessionId || '-'}`)
      return
    }
    notify('approval', sessionId, approvalLines(session, toolName, reason), settings.soundApproval, extra)
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const id = String(session.id)
      if (event.type === 'turn/start') {
        turns.set(id, { turn: Number(event.data?.turn), snippet: '', reason: undefined })
        return
      }
      if (event.type === 'turn/end') {
        remember(id, { reason: String(event.data?.reason?.kind || '') })
        return
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data?.message)
        if (text) remember(id, { snippet: text })
        return
      }
      if (event.type === 'tool/call') {
        // The web bridge claims `user-questions/request` before any other
        // listener sees it, so the question itself is read off the log.
        if (String(event.data?.name || '') === 'ask_user_question') {
          const callId = String(event.data?.callId || event.data?.id || '')
          if (announce(`${id}|question|${callId}`)) {
            announceQuestion(session, null, questionsFromCall(event.data), id, callId)
          }
        }
        return
      }
      if (event.type === 'approval/asked') {
        const data = event.data || {}
        // Both seams carry the tool call id, so that is what keeps one request
        // from ringing twice; the audit id is only a fallback.
        const key = `${id}|approval|${String(data.callId || data.id || '')}`
        if (announce(key)) {
          // The page usually owns the request itself, so the buttons also work
          // for a notice the plugin only observed: the page answers its own
          // pending request when the button comes back through jump.ps1.
          const callId = String(data.callId || '')
          const extra = settings.replyInToast !== false && settings.clickToOpen !== false && callId
            ? { actions: approvalActions(callId) }
            : undefined
          notifyApproval(session, data.toolName, data.reason, extra)
        }
        return
      }
      if (event.type === 'goal/change') {
        const change = event.data || {}
        const goal = change.goal
        if (goal && goal.phase) goals.set(id, { phase: String(goal.phase), rounds: Number(change.roundsStarted || 0) })
        else goals.delete(id)
        return
      }
      if (event.type === 'user/message' && !prompts.has(id)) {
        const text = messageText(event.data?.message)
        if (text) {
          prompts.set(id, text)
          if (prompts.size > STATE_LIMIT) {
            const oldest = prompts.keys().next()
            if (!oldest.done) prompts.delete(oldest.value)
          }
        }
      }
    } catch (error) {
      report(`session/event error ${describeError(error)}`)
    }
  })

  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent
      const status = payload?.status
      const session = agent?.session
      if (!session) return
      const id = String(agent.id ?? session.id ?? '')

      if (status === 'running') {
        started.set(id, Date.now())
        return
      }
      if (status !== 'idle') return

      const startedAt = started.get(id)
      started.delete(id)
      // A session that was never observed running (an idle re-emit, or a
      // session created before this plugin loaded) has no measurable turn.
      if (startedAt === undefined) return

      const header = session.header
      if (!settings.includeSubagents && isSubagent(header)) {
        report(`skip subagent session=${id}`)
        return
      }

      const elapsed = Math.max(0, Date.now() - startedAt)
      if (elapsed < Number(settings.minDurationMs || 0)) {
        report(`skip short session=${id} elapsed=${elapsed}ms`)
        return
      }

      const sessionId = String(session.id)
      if (settings.notifyTurn === false) {
        report(`turn notification off session=${sessionId}`)
        return
      }
      if (watching(sessionId)) {
        report(`skip focused session=${sessionId}`)
        return
      }
      const goal = goals.get(sessionId)
      // A goal keeps starting rounds on its own: announcing every round would
      // turn one objective into a stream of identical popups. The last round,
      // where the goal completes or blocks, is still announced below.
      if (goal && goal.phase === 'active' && settings.suppressWhileGoal !== false) {
        report(`goal round session=${sessionId} rounds=${goal.rounds} — quiet until it ends`)
        return
      }

      const outcome = turns.get(sessionId) || {}
      turns.delete(sessionId)

      const title = titleOf(session, agent)
      const folder = shortenDirectory(header?.cwd)
      const meta = [strings.duration(formatDuration(elapsed, language))]
      if (folder) meta.push(strings.folder(folder))

      let headline = strings[outcome.reason] || strings.finished
      if (goal && goal.phase === 'complete') headline = strings.goalDone
      else if (goal && goal.phase === 'blocked') headline = strings.goalBlocked
      const lines = [`${headline} · ${title}`, meta.join(' · ')]
      if (settings.snippet && outcome.snippet) lines.push(truncate(outcome.snippet, SNIPPET_LIMIT))

      notify('turn', sessionId, lines, settings.soundComplete)
    } catch (error) {
      report(`agent/status error ${describeError(error)}`)
    }
  })

  // The agent stopped to ask something: the user has to come back to the app.
  // The web bridge usually claims this waterfall first, so the log seam above is
  // what rings in a normal session; this one still fires when nothing else takes
  // the request.
  ctx.on('user-questions/request', (request, next) => {
    try {
      const agent = request?.agent
      const session = agent?.session
      const sessionId = String(session?.id || '')
      const callId = String(request?.wait?.callId || '')
      if (announce(`${sessionId}|question|${callId}`)) {
        const items = Array.isArray(request?.questions) ? request.questions : []
        announceQuestion(session, agent, items, sessionId, String(request?.wait?.callId || ''))
      }
    } catch (error) {
      report(`user-questions error ${describeError(error)}`)
    }
    // A waterfall listener that swallows the request would stall the agent.
    return next()
  })

  ctx.on('approval/request', (request, next) => {
    const callId = String(request?.callId || '')
    const agent = request?.agent
    const session = agent?.session
    const sessionId = String(session?.id || '')
    const reason = pickText(request?.displayReason, language) || String(request?.reason || '')
    const toolName = String(request?.toolName || '')

    // A grant the user already gave from a toast button: answer it here so the
    // same request stops interrupting them.
    if (settings.replyInToast !== false && sessionAllowsRequest(sessionId, toolName, reason)) {
      report(`approval allowed by earlier session grant session=${sessionId || '-'} tool=${toolName || '-'}`)
      return 'allowed-once'
    }

    // The session log announces the request too, and it does so first in a normal
    // session. When it already rang, this listener only defers: holding the
    // request here would wait for a toast button nobody was shown.
    if (!announce(`${sessionId}|approval|${callId}`)) return next()

    if (settings.notifyApprovals === false) return next()
    if (watching(sessionId)) {
      report(`skip focused approval session=${sessionId || '-'}`)
      return next()
    }

    // Without a call id, or with the buttons switched off, the toast is only a
    // notification and the app keeps the request. macOS never has buttons, so
    // there is nothing to wait for there either.
    if (isMac || settings.replyInToast === false || !callId) {
      notifyApproval(session, toolName, reason)
      return next()
    }

    const timeoutMs = Math.max(5_000, Number(settings.approvalTimeoutMs) || 180_000)
    return new Promise((resolve) => {
      let settled = false
      let timer
      const finish = (outcome) => {
        if (settled) return
        settled = true
        claims.delete(callId)
        clearTimeout(timer)
        try {
          request?.signal?.removeEventListener?.('abort', onAbort)
        } catch {
          // An unusual signal object must not trap the request.
        }
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled')
      if (request?.signal?.aborted) return finish('cancelled')

      timer = setTimeout(() => {
        report(`approval toast timed out call=${callId}; handing it back to the app`)
        finish('delegate')
      }, timeoutMs)
      timer.unref?.()
      try {
        request?.signal?.addEventListener?.('abort', onAbort, { once: true })
      } catch {
        // Same as above: keep going without the abort hook.
      }

      claims.set(callId, {
        decide(action) {
          report(`approval decided from toast call=${callId} action=${action}`)
          if (action === 'allow-session') {
            rememberSessionAllow(sessionId, request?.toolName, reason)
            report(`session grant stored session=${sessionId || '-'} tool=${request?.toolName || '-'} reason=${JSON.stringify(reason)}`)
            return finish('allowed-once')
          }
          finish(action === 'allow' ? 'allowed-once' : 'rejected')
        },
      })

      notifyApproval(session, toolName, reason, { actions: approvalActions(callId) })
    }).then((outcome) => (outcome === 'delegate' ? next() : outcome))
  })

  /**
   * The decision buttons, mirroring the card the page is showing: an ordinary
   * tool approval offers "allow once" and "deny" only. DSH has no session-scoped
   * approval of its own, so inventing a third button here would promise
   * something the in-app card cannot do.
   */
  function approvalActions(callId) {
    const id = encodeURIComponent(callId)
    return [
      { label: strings.allowOnce, activationType: 'protocol', arguments: `${PROTOCOL}:?action=allow&call=${id}` },
      { label: strings.deny, activationType: 'protocol', arguments: `${PROTOCOL}:?action=deny&call=${id}` },
    ]
  }

  if (settings.clickToOpen !== false && !isMac) installJumpTarget(log)

  // The plugin page reads and writes its switches here, so the route stays
  // registered even when click-to-open is off; only the jump wiring is
  // optional. The path is versioned so an older module generation, which still
  // owns the legacy prefix until DSH restarts, cannot shadow the current one.
  const bridge = {
    report,
    panel: { snapshot: panelSnapshot, update: updatePanel, sounds: soundChoices },
    preview,
    pick: pickSoundFile,
    presence: updatePresence,
    /** Notifications waiting for a live page to show them (macOS only). */
    inbox: listInbox,
    claim: claimMac,
    /** Stream one sound file so the page can play it with the right volume. */
    sound: serveSound,
    /**
     * A batch is answered one question at a time: after a click the page asks
     * for the next question, and this puts that question on screen with its own
     * buttons. False means the card is gone (the page already settled it).
     */
    step(body) {
      const callId = String(body?.call || '')
      const card = callId ? questionCards.get(callId) : undefined
      if (!card) return false
      const step = Math.min(Math.max(Number(body?.step) || 0, 0), Math.max(card.total - 1, 0))
      const actions = settings.replyInToast !== false && settings.clickToOpen !== false
        ? questionActions(callId, card.items, step)
        : []
      notify('question', card.sessionId, card.linesFor(step), settings.soundQuestion,
        actions.length > 0 ? { actions } : undefined)
      return true
    },
    /** Resolve one claimed approval; false means it already expired. */
    decide(body) {
      const callId = String(body?.call || '')
      const action = String(body?.action || '')
      if (action !== 'allow' && action !== 'allow-session' && action !== 'deny') return false
      const claim = claims.get(callId)
      if (claim) {
        claim.decide(action)
        return true
      }
      // When the page owns the request, the answer is taken there; only the
      // session-wide grant has to be remembered here so later requests of the
      // same shape are allowed without a second notification.
      if (action !== 'allow-session') return false
      const sessionId = String(body?.sessionId || '')
      const toolName = String(body?.toolName || '')
      if (!sessionId || !toolName) return false
      rememberSessionAllow(sessionId, toolName, String(body?.reason || ''))
      report(`session grant from page session=${sessionId} tool=${toolName}`)
      return true
    },
  }
  const handler = createClickHandler(bridge)
  // Keep the newest handler reachable from whichever module generation owns the
  // route: a reload of the plugin tears down its own registration only when the
  // fiber is disposed, and a stale generation would otherwise keep serving old
  // logic for the rest of the process lifetime.
  globalThis[ROUTE_SLOT] = handler
  const routeEntry = (req, res) => {
    const current = globalThis[ROUTE_SLOT] || handler
    return current(req, res)
  }
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => {
        try {
          const dispose = scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler: routeEntry })
          return () => dispose()
        } catch (error) {
          // A previous module generation already owns this path and keeps
          // serving it with the same behaviour, so the feature still works.
          report(`route already owned, reusing it: ${describeError(error)}`)
          return () => {}
        }
      })
    })
  } catch (error) {
    report(`webServer unavailable ${describeError(error)}`)
  }

  /**
   * Notifications a live page has not shown yet. The page asks with the last id
   * it saw, so a reload never repeats a notice and a missed one is delivered.
   */
  function listInbox(since) {
    const after = Number(since) || 0
    return {
      cursor: inbox.nextId - 1,
      items: inbox.items.filter((entry) => entry.id > after).map((entry) => ({ id: entry.id, ...entry.item })),
    }
  }

  /** Hand one queued notification to the page; null means it is already gone. */
  function claimMac(id) {
    const index = inbox.items.findIndex((entry) => entry.id === Number(id))
    if (index < 0) return null
    const [entry] = inbox.items.splice(index, 1)
    report(`mac claimed id=${entry.id} session=${entry.item.sessionId || '-'}`)
    return { id: entry.id, ...entry.item }
  }

  function deliverMac(item) {
    const entry = { id: inbox.nextId++, item }
    inbox.items.push(entry)
    if (inbox.items.length > 20) inbox.items.shift()
    const timer = setTimeout(() => {
      // Nothing claimed it: this process posts the notification itself. The
      // trade-off is that an osascript notification has no click handler.
      const index = inbox.items.findIndex((candidate) => candidate.id === entry.id)
      if (index < 0) return
      inbox.items.splice(index, 1)
      report(`mac fallback id=${entry.id} session=${item.sessionId || '-'}`)
      showMacToast(item)
    }, MAC_FALLBACK_MS)
    timer.unref?.()
  }

  function showMacToast(item) {
    const [title, subtitle, body] = item.lines
    const script = [
      'on run argv',
      'set theTitle to item 1 of argv',
      'set theSubtitle to item 2 of argv',
      'set theBody to item 3 of argv',
      'if theBody is "" then',
      'display notification theSubtitle with title theTitle',
      'else',
      'display notification theBody with title theTitle subtitle theSubtitle',
      'end if',
      'end run',
    ].join('\n')
    runMac(OSASCRIPT, ['-e', script, String(title || ''), String(subtitle || ''), String(body || '')], 'notification')
    playMacSound(item.sound, item.volume)
  }

  function playMacSound(sound, volume) {
    const file = macSoundPath(sound, settings.customSounds)
    if (!file || !existsSync(file)) return
    const level = Math.max(0, Math.min(100, Math.round(Number(volume) || 0))) / 100
    runMac(AFPLAY, ['-v', level.toFixed(2), file], 'sound')
  }

  function runMac(command, args, label) {
    if (!existsSync(command)) {
      report(`mac ${label}: ${command} missing`)
      return
    }
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      child.stdout?.on('data', () => {})
      child.on('error', (error) => report(`mac ${label} error ${describeError(error)}`))
      child.on('close', (code) => {
        report(code === 0 ? `mac ${label} ok` : `mac ${label} failed exit=${code} ${stderr.trim().slice(0, 200)}`)
      })
    } catch (error) {
      report(`mac ${label} spawn failed ${describeError(error)}`)
    }
  }

  /** Serve a sound file to the page so it can play it at the right volume. */
  function serveSound(res, name) {
    const file = macSoundPath(name, settings.customSounds)
    if (!file || !existsSync(file)) {
      res.statusCode = 404
      res.end()
      return Promise.resolve()
    }
    return readFile(file)
      .then((data) => {
        const extension = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() || ''
        res.statusCode = 200
        res.setHeader('content-type', MAC_MIME_TYPES[extension] || 'application/octet-stream')
        res.setHeader('cache-control', 'no-store')
        res.end(data)
      })
      .catch(() => {
        res.statusCode = 500
        res.end()
      })
  }

  /** Play one notification sound without leaving the settings panel. */
  function preview(sound) {
    const choice = typeof sound === 'string' && sound ? sound : settings.soundComplete
    if (isMac) {
      report(`preview sound=${macSoundPath(choice, settings.customSounds) || 'silent'}`)
      playMacSound(choice, 100)
      return
    }
    const value = resolveSound(choice, settings.customSounds)
    report(`preview sound=${value}`)
    showToast({
      appId: String(settings.appId),
      tag: 'dsh-session-toast-preview',
      group: 'dsh-session-toast',
      sound: value,
      lines: [strings.preview, strings.previewDetail],
    }, report)
  }

  report(`activated includeSubagents=${settings.includeSubagents} sounds=${settings.soundComplete}/${settings.soundQuestion}`)

  function titleOf(session, agent) {
    const sessionId = String(session?.id || '')
    return readTitle(ctx, session, agent)
      || truncate(prompts.get(sessionId) || '', 40)
      || strings.untitled
  }

  function notify(kind, sessionId, lines, sound, extra) {
    const quiet = inQuietWindow(kind)
    const volume = volumeFor(kind)
    const muted = quiet || volume <= 0
    // Only the first three text elements reach the screen.
    const texts = (Array.isArray(lines) ? lines : [])
      .filter((line) => typeof line === 'string' && line.trim() !== '')
      .slice(0, NOTIFY_LINES)
    if (isMac) {
      const item = {
        kind,
        sessionId: String(sessionId || ''),
        lines: texts,
        // Keep the friendly name: the page streams the file through our route
        // so it can play it at the requested volume.
        sound: muted ? 'silent' : String(sound || settings.soundComplete),
        volume: muted ? 0 : volume,
        clickToOpen: settings.clickToOpen !== false && Boolean(sessionId),
        // A macOS notice shown by the page has no buttons: the browser
        // Notification API does not offer any, and the osascript fallback cannot
        // carry them either. macOS is a reminder-only platform.
        actions: [],
      }
      report(`mac notify kind=${kind} session=${item.sessionId || '-'} sound=${item.sound} volume=${item.volume} quiet=${quiet} click=${item.clickToOpen ? 'yes' : 'no'} actions=${item.actions.length} lines=${JSON.stringify(texts)}`)
      deliverMac(item)
      return
    }
    const payload = {
      appId: String(settings.appId),
      tag: sessionTag(sessionId),
      group: 'dsh-session-toast',
      sound: muted ? 'silent' : resolveSound(sound, settings.customSounds),
      volume,
      lines: texts,
    }
    if (extra && Array.isArray(extra.actions) && extra.actions.length > 0) payload.actions = extra.actions
    // Blink the taskbar button of this process next to the notification; the
    // helper refuses when the window is already in front.
    if (settings.flashTaskbar !== false) {
      payload.flash = true
      payload.windowPid = process.pid
    }
    if (settings.clickToOpen !== false && sessionId) {
      payload.activationType = 'protocol'
      payload.launch = `${PROTOCOL}:?session=${encodeURIComponent(sessionId)}`
    }
    report(`notify kind=${kind} session=${sessionId || '-'} sound=${payload.sound} volume=${volume} quiet=${quiet} flash=${payload.flash ? 'yes' : 'no'} click=${payload.launch ? 'yes' : 'no'} actions=${payload.actions ? payload.actions.length : 0} lines=${JSON.stringify(texts)}`)
    showToast(payload, report)
  }
}

function sessionTag(sessionId) {
  const value = String(sessionId || '')
  return (value || 'dsh-session').slice(0, 64)
}

/**
 * Map a friendly sound name to what the PowerShell side understands:
 * `ms-winsoundevent:…` for a system sound, `file:<path>` for a user file, or
 * `silent`.
 */
function resolveSound(sound, custom) {
  if (sound === false || sound === null || sound === undefined) return 'silent'
  const value = String(sound).trim()
  if (value === '' || value === 'silent' || value === 'none' || value === 'off') return 'silent'
  if (value === true || value === 'on' || value === 'default') return SOUNDS.default
  if (value.startsWith('custom:')) {
    const name = value.slice('custom:'.length)
    const file = custom && typeof custom === 'object' ? custom[name] : undefined
    return typeof file === 'string' && file ? `file:${file}` : 'silent'
  }
  const packed = PACK_SOUNDS[value]
  if (packed) {
    const file = join(SOUND_DIR, packed)
    return existsSync(file) ? `file:${file}` : 'silent'
  }
  return SOUNDS[value] || LEGACY_SOUNDS[value] || value
}

/** System chimes expressed as the files macOS ships in /System/Library/Sounds. */
const WINSOUND_TO_MAC = {
  'ms-winsoundevent:Notification.Default': MAC_SOUNDS.default,
  'ms-winsoundevent:Notification.Reminder': MAC_SOUNDS.reminder,
  'ms-winsoundevent:Notification.Mail': MAC_SOUNDS.mail,
  'ms-winsoundevent:Notification.SMS': MAC_SOUNDS.reminder,
  'ms-winsoundevent:Notification.IM': MAC_SOUNDS.reminder,
  'ms-winsoundevent:Notification.Looping.Alarm': MAC_SOUNDS.default,
}

/** Content types for the sounds the page may stream. */
const MAC_MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
}

/**
 * A concrete audio file for a friendly sound name, or `''` for silence. Used by
 * `afplay` in this process and by the sound route the page streams.
 */
function macSoundPath(sound, custom) {
  const resolved = resolveSound(sound, custom)
  if (resolved === 'silent') return ''
  if (resolved.startsWith('file:')) {
    const file = resolved.slice('file:'.length)
    return existsSync(file) ? file : ''
  }
  const mapped = WINSOUND_TO_MAC[resolved]
  if (mapped) return existsSync(mapped) ? mapped : ''
  return existsSync(resolved) ? resolved : ''
}

/** Keep only well-formed `{ name: path }` pairs coming from the panel. */
function pickCustomSounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const picked = {}
  for (const [rawName, rawPath] of Object.entries(value)) {
    if (Object.keys(picked).length >= 12) break
    if (typeof rawName !== 'string' || typeof rawPath !== 'string') continue
    const name = rawName.trim()
    const path = rawPath.trim()
    if (!name || name.length > 24) continue
    if (!path || path.length > 260 || !/\.(wav|mp3)$/i.test(path)) continue
    picked[name] = path
  }
  return picked
}

/**
 * Ask the user for an audio file with the native picker. Runs in its own
 * PowerShell process so a cancelled or slow dialog cannot block the host.
 */
function pickSoundFile(report) {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      "$dialog.Title = 'Notification sound'",
      "$dialog.Filter = 'Audio (*.wav;*.mp3)|*.wav;*.mp3|WAV audio (*.wav)|*.wav|MP3 audio (*.mp3)|*.mp3'",
      '$dialog.Multiselect = $false',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
    ].join('; ')
    let out = ''
    const timer = setTimeout(() => {
      report('pick timed out')
      resolve('')
    }, 60_000)
    timer.unref?.()
    try {
      const child = spawn(POWERSHELL, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk) => {
        out += chunk.toString('utf8')
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const file = out.trim().split(/\r?\n/).pop() || ''
        report(`pick exit=${code} file=${file || 'none'}`)
        resolve(/\.(wav|mp3)$/i.test(file) ? file : '')
      })
    } catch (error) {
      clearTimeout(timer)
      report(`pick failed ${describeError(error)}`)
      resolve('')
    }
  })
}

function pickText(display, language) {
  if (!display) return ''
  if (typeof display === 'string') return display
  if (typeof display === 'object') {
    const value = display[language] || display.zh || display.en
    if (typeof value === 'string') return value
  }
  return ''
}

/** Register the toast protocol so a click can name the session to jump to. */
function installJumpTarget(log) {
  if (!existsSync(JUMP_SCRIPT)) {
    log(`${new Date().toISOString()} jump script missing at ${JUMP_SCRIPT}`)
    return
  }
  const quietLaunch = existsSync(WSCRIPT) && existsSync(LAUNCH_SCRIPT)
  const command = quietLaunch
    ? `"${WSCRIPT}" //B //Nologo "${LAUNCH_SCRIPT}" "%1"`
    : `"${POWERSHELL}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${JUMP_SCRIPT}" "%1"`
  const key = `HKCU\\Software\\Classes\\${PROTOCOL}`
  const steps = [
    [key, '/ve', '/d', 'URL:dsh-session-toast', '/f'],
    [key, '/v', 'URL Protocol', '/d', '', '/f'],
    [`${key}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
  ]
  for (const args of steps) {
    try {
      const child = spawn(REG, ['add', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      child.on('close', (code) => {
        if (code !== 0) log(`${new Date().toISOString()} reg add failed ${args[0]} exit=${code} ${stderr.trim().slice(0, 200)}`)
      })
    } catch (error) {
      log(`${new Date().toISOString()} reg add error ${describeError(error)}`)
    }
  }
}

/** Read the persisted panel switches; a missing or broken file is simply empty. */
function readStore() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeStore(values) {
  try {
    await mkdir(dirname(STORE_FILE), { recursive: true })
    await writeFile(STORE_FILE, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
  } catch (error) {
    // A read-only home must not break notifications; the value still applies
    // for this process, it just will not survive a restart.
    void error
  }
}

/**
 * Serve the plugin page and the toast click:
 * `GET …/settings` and `POST …/settings` for the switches, `POST …/preview` for
 * the sound test, `GET …/pending` + `POST …/ack` for the click-to-open handoff.
 * Loopback callers only.
 */
function createClickHandler(bridge) {
  const { report, panel, preview, pick, presence, decide, inbox, claim, sound, step } = bridge

  return async function handler(req, res) {
    try {
      const remote = String(req.socket?.remoteAddress || '')
      const local = remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!local) {
        res.statusCode = 404
        res.end()
        return
      }
      const url = String(req.url || '')

      if (url.startsWith(`${ROUTE}/settings`)) {
        if (req.method === 'POST') {
          const body = parseJson(await readBody(req, 4_000))
          const changed = await panel.update(body)
          sendJson(res, 200, { ok: changed, values: panel.snapshot(), sounds: panel.sounds() })
          return
        }
        sendJson(res, 200, { ok: true, values: panel.snapshot(), sounds: panel.sounds() })
        return
      }

      if (url.startsWith(`${ROUTE}/pick`) && req.method === 'POST') {
        const file = await pick(report)
        sendJson(res, 200, { path: file || null })
        return
      }

      if (url.startsWith(`${ROUTE}/presence`) && req.method === 'POST') {
        presence(parseJson(await readBody(req, 800)))
        res.statusCode = 204
        res.end()
        return
      }

      if (url.startsWith(`${ROUTE}/decide`) && req.method === 'POST') {
        const body = parseJson(await readBody(req, 800))
        const applied = decide(body)
        report(`decide call=${body?.call || '-'} action=${body?.action || '-'} applied=${applied}`)
        sendJson(res, 200, { ok: applied })
        return
      }

      if (url.startsWith(`${ROUTE}/preview`) && req.method === 'POST') {
        const body = parseJson(await readBody(req, 1_000))
        preview(body?.sound)
        res.statusCode = 204
        res.end()
        return
      }

      // macOS: the page shows the notification and plays the sound itself, so
      // it needs the queue and the audio bytes.
      if (url.startsWith(`${ROUTE}/inbox`)) {
        const query = new URL(url, 'http://127.0.0.1').searchParams
        if (url.startsWith(`${ROUTE}/inbox/claim`) && req.method === 'POST') {
          const body = parseJson(await readBody(req, 400))
          const item = claim(body?.id)
          sendJson(res, 200, { item: item || null })
          return
        }
        const listing = inbox(query.get('since'))
        sendJson(res, 200, listing)
        return
      }

      if (url.startsWith(`${ROUTE}/sound`)) {
        const name = new URL(url, 'http://127.0.0.1').searchParams.get('name') || ''
        await sound(res, name)
        return
      }

      if (url.startsWith(`${ROUTE}/ack`)) {
        const text = await readBody(req, 400)
        report(`ack ${text || '(empty)'}`)
        res.statusCode = 204
        res.end()
        return
      }

      if (url.startsWith(`${ROUTE}/step`) && req.method === 'POST') {
        const body = parseJson(await readBody(req, 1_000))
        const applied = step(body)
        report(`step requested call=${body?.call || '-'} step=${body?.step ?? '-'} applied=${applied}`)
        sendJson(res, 200, { ok: applied })
        return
      }

      if (!url.startsWith(`${ROUTE}/pending`)) {
        res.statusCode = 404
        res.end()
        return
      }

      const pending = await takePending()
      report(`pending read session=${pending.sessionId || 'none'} action=${pending.action || '-'} site=${req.headers?.['sec-fetch-site'] || '-'} origin=${req.headers?.origin || '-'}`)
      sendJson(res, 200, {
        sessionId: pending.sessionId || null,
        action: pending.action || null,
        call: pending.call || null,
        index: Number(pending.index || 0),
        step: Number(pending.step || 0),
      })
    } catch (error) {
      report(`route error ${describeError(error)}`)
      res.statusCode = 500
      res.end()
    }
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function parseJson(text) {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Read a request body, capped so a misbehaving caller cannot grow memory. */
function readBody(req, limit = 400) {
  return new Promise((resolve) => {
    let text = ''
    const done = () => resolve(text.slice(0, limit))
    req.setEncoding?.('utf8')
    req.on('data', (chunk) => {
      if (text.length > limit) return
      text += String(chunk)
    })
    req.on('end', done)
    req.on('error', done)
    setTimeout(done, 1000).unref?.()
  })
}

async function takePending() {
  try {
    const raw = await readFile(PENDING_FILE, 'utf8')
    await rm(PENDING_FILE, { force: true })
    const text = raw.trim()
    if (!text) return {}
    if (text.startsWith('{')) {
      const parsed = parseJson(text)
      if (parsed && typeof parsed === 'object') {
        const action = typeof parsed.action === 'string' ? parsed.action : ''
        const index = Number(parsed.index)
        const step = Number(parsed.step)
        return {
          sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId.slice(0, 200) : '',
          // Every action the toast can send: the three approval answers and the
          // question answer the option buttons carry.
          action: PENDING_ACTIONS.has(action) ? action : '',
          call: typeof parsed.call === 'string' ? parsed.call.slice(0, 200) : '',
          index: Number.isFinite(index) ? Math.min(8, Math.max(0, Math.trunc(index))) : 0,
          // Which question of a batch the click belongs to.
          step: Number.isFinite(step) ? Math.min(11, Math.max(0, Math.trunc(step))) : 0,
        }
      }
    }
    // Older jump scripts wrote the bare session id.
    return { sessionId: text.slice(0, 200) }
  } catch {
    return {}
  }
}

function isSubagent(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return Number(header.delegationDepth || 0) > 0
}

function resolveLanguage(language) {
  if (language === 'zh' || language === 'en') return language
  try {
    const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || '')
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

function readTitle(ctx, session, agent) {
  try {
    const snapshot = ctx.sessionTitle?.get?.(session)
    const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
    if (title) return title
  } catch {
    // A missing title service must not cost the notification.
  }
  const name = agent?.name
  return typeof name === 'string' ? name.trim() : ''
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return clean(content)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return clean(parts.join(' '))
}

/** Collapse whitespace and drop the most distracting Markdown markers. */
function clean(text) {
  return String(text)
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]+/g, '')
    .replace(/^[#>\s]+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text, limit) {
  const value = String(text)
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1).trimEnd()}…`
}

function shortenDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return cwd
  // Keep the separator the working directory itself uses.
  const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? '\\' : '/'
  return parts.slice(-2).join(separator)
}

function formatDuration(ms, language) {
  const total = Math.max(0, Math.round(ms / 1000))
  const chinese = language === 'zh'
  const seconds = chinese ? (value) => `${value} 秒` : (value) => `${value}s`
  const minutes = chinese ? (value) => `${value} 分` : (value) => `${value}m`
  if (total < 60) return seconds(total)
  const mins = Math.floor(total / 60)
  const restSeconds = total % 60
  if (mins < 60) {
    if (restSeconds === 0) return minutes(mins)
    return `${minutes(mins)} ${seconds(restSeconds)}`
  }
  const hours = Math.floor(mins / 60)
  const restMinutes = mins % 60
  const hourText = chinese ? `${hours} 小时` : `${hours}h`
  return restMinutes === 0 ? hourText : `${hourText} ${minutes(restMinutes)}`
}

function showToast(payload, report) {
  if (!existsSync(TOAST_SCRIPT)) {
    report(`toast script missing at ${TOAST_SCRIPT}`)
    return
  }
  if (!existsSync(POWERSHELL)) {
    report(`Windows PowerShell 5.1 missing at ${POWERSHELL}`)
    return
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    TOAST_SCRIPT,
    '-Payload',
    encoded,
  ]

  let child
  try {
    child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    report(`spawn failed ${describeError(error)}`)
    return
  }

  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  child.stdout?.on('data', () => {})
  child.on('error', (error) => report(`toast process error ${describeError(error)}`))
  child.on('close', (code) => {
    if (code === 0) {
      report('toast shown')
      return
    }
    report(`toast failed exit=${code} ${stderr.trim().slice(0, 400)}`)
  })
}

function appendLine(path, line) {
  try {
    appendFile(path, `${line}\n`, 'utf8').catch(() => {})
  } catch {
    // Diagnostics must never break a session.
  }
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
