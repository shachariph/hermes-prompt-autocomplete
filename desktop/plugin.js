/**
 * Prompt Autocomplete v2 — Zero-DOM-Lag, Implied LTR/RTL, Dual-Tier (0ms WebWorker + Fast Small Model Race)
 *
 * Designed specifically for zero typing lag and sub-second intelligence:
 *   1. ZERO DOM mutations inside the contentEditable editor:
 *      Renders as a lightweight non-intrusive bar in `COMPOSER_AREAS.top` using
 *      pure React state. Typing in the prompt box stays 100% native speed.
 *   2. Implied LTR / RTL Direction Detection:
 *      No manual toggle. Automatically inspects the last strong Unicode character
 *      before the caret (Hebrew/Arabic `\u0590-\u08FF` -> RTL `←` vs Latin -> LTR `→`).
 *      - In LTR: `ArrowRight` accepts the full completion, `Ctrl+ArrowRight` accepts 1 word, `Tab` accepts full.
 *      - In RTL: `ArrowLeft` accepts the full completion, `Ctrl+ArrowLeft` accepts 1 word, `Tab` accepts full.
 *   3. Two-Tier Speed Engine:
 *      - Tier 1 (< 1 ms): Off-main-thread WebWorker N-gram / Prefix Trie trained on your
 *        actual `state.db` prompt history (via `ctx.rest('/corpus')`)
 *        plus bilingual English & Hebrew phrase patterns.
 *      - Tier 2 (~450–600 ms): Parallel small-model race via `ctx.rest('/complete')`
 *        (`qwen-2.5-7b-instruct` + `llama-3.1-8b-instruct` + `llama-4-scout` + `gemini-3.5-flash-lite`),
 *        where the first model to return a clean suffix wins.
 */

import {
  cn,
  COMPOSER_AREAS,
  haptic,
  host,
  icons,
  STATUSBAR_AREAS,
  StatusDot,
  Tip
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'prompt-autocomplete'

// ── Unicode Direction Detection (100% Automatic / Implied) ──────────────────

const RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const LTR_CHAR_RE = /[A-Za-z]/

/**
 * Resolve implied direction ('ltr' | 'rtl') from the last strong directional
 * character in `text`, scanning backwards from the caret. Never asks the user.
 */
function inferDirection(text) {
  if (!text) return 'ltr'
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (RTL_CHAR_RE.test(ch)) return 'rtl'
    if (LTR_CHAR_RE.test(ch)) return 'ltr'
  }
  return 'ltr'
}

function isCaretAtEnd(editor) {
  if (!editor) return false
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) return false

  try {
    const postRange = document.createRange()
    postRange.selectNodeContents(editor)
    postRange.setStart(range.endContainer, range.endOffset)
    return postRange.toString().trim().length === 0
  } catch {
    return false
  }
}

// ── Off-Main-Thread WebWorker (0ms Local Prefix & N-gram Engine) ────────────

const WORKER_SOURCE = `
const BUILTIN_LTR = [
  "can you check the logs and see what failed",
  "can you check the status of all production services",
  "check laptop ram usage and top processes",
  "deploy the latest changes to production",
  "prepare git branch and push to origin",
  "run the test suite and fix any failing tests",
  "verify the changes and report back",
  "show me what changed in the last commit",
  "fix the merge conflicts and push",
  "review the code changes before committing",
  "optimize performance and reduce latency"
];

const BUILTIN_RTL = [
  "תבדוק בבקשה את הלוגים ותראה אם יש שגיאות",
  "תבדוק מה המצב של השרתים בפרודקשן",
  "תריץ את הטסטים ותתקן את מה שנכשל",
  "בוא נבדוק למה השרת איטי",
  "תכין ענף גיט ותדחוף ל-origin",
  "תראה לי מה השתנה בקומיט האחרון",
  "תסדר את הקונפליקטים במיזוג ותעדכן",
  "תבדוק את השימוש בזיכרון של הלפטופ",
  "תעדכן את הפלאגין ותוודא שהכל עובד חלק",
  "תעשה בדיקה מלאה ותחזור אליי עם תשובה"
];

let phrases = [...BUILTIN_LTR, ...BUILTIN_RTL];
let nextWordMap = new Map();

function rebuildIndex(extraPhrases) {
  const seen = new Set();
  const all = [];
  for (const p of [...(extraPhrases || []), ...BUILTIN_LTR, ...BUILTIN_RTL]) {
    if (typeof p !== 'string') continue;
    const clean = p.replace(/\\s+/g, ' ').trim();
    const low = clean.toLowerCase();
    if (clean.length >= 6 && !seen.has(low)) {
      seen.add(low);
      all.push(clean);
    }
  }
  phrases = all;
  nextWordMap.clear();

  for (const sentence of phrases) {
    const words = sentence.split(' ');
    for (let i = 0; i < words.length - 1; i++) {
      const rest = words.slice(i + 1, i + 6).join(' ');
      if (!rest) continue;
      const k1 = words[i].toLowerCase();
      if (!nextWordMap.has(k1)) nextWordMap.set(k1, []);
      nextWordMap.get(k1).push(rest);

      if (i >= 1) {
        const k2 = (words[i - 1] + ' ' + words[i]).toLowerCase();
        if (!nextWordMap.has(k2)) nextWordMap.set(k2, []);
        nextWordMap.get(k2).push(rest);
      }
      if (i >= 2) {
        const k3 = (words[i - 2] + ' ' + words[i - 1] + ' ' + words[i]).toLowerCase();
        if (!nextWordMap.has(k3)) nextWordMap.set(k3, []);
        nextWordMap.get(k3).push(rest);
      }
    }
  }
}

rebuildIndex([]);

function queryLocal(rawText) {
  if (!rawText || rawText.length < 3) return '';
  const lines = rawText.split(/\\r?\\n/);
  const line = lines[lines.length - 1];
  if (!line || line.trim().length < 3) return '';
  if (line.trim().startsWith('/') || line.trim().startsWith('@')) return '';

  const endsWithSpace = /\\s$/.test(line);
  const trimmed = line.trim();
  const lowLine = trimmed.toLowerCase();

  for (const p of phrases) {
    const lowP = p.toLowerCase();
    if (lowP.startsWith(lowLine) && p.length > trimmed.length + 2) {
      let suffix = p.slice(trimmed.length);
      if (endsWithSpace && suffix.startsWith(' ')) {
        suffix = suffix.slice(1);
      }
      const words = suffix.trim().split(' ').slice(0, 6).join(' ');
      return (!endsWithSpace && suffix.startsWith(' ') ? ' ' : '') + words;
    }
  }

  const words = trimmed.split(/\\s+/);
  if (endsWithSpace) {
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const key = words.slice(-n).join(' ').toLowerCase();
      const hits = nextWordMap.get(key);
      if (hits && hits.length > 0) {
        return hits[0];
      }
    }
  } else {
    const partial = words[words.length - 1].toLowerCase();
    if (partial.length >= 2) {
      const prevKey = words.length >= 2 ? words[words.length - 2].toLowerCase() : null;
      if (prevKey && nextWordMap.has(prevKey)) {
        for (const cand of nextWordMap.get(prevKey)) {
          if (cand.toLowerCase().startsWith(partial) && cand.length > partial.length) {
            return cand.slice(partial.length);
          }
        }
      }
      for (const p of phrases) {
        const pWords = p.split(' ');
        for (let i = 0; i < pWords.length; i++) {
          if (pWords[i].toLowerCase().startsWith(partial) && pWords[i].length > partial.length) {
            const tail = [pWords[i].slice(partial.length), ...pWords.slice(i + 1, i + 5)].join(' ');
            return tail;
          }
        }
      }
    }
  }

  return '';
}

self.onmessage = function(ev) {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    rebuildIndex(msg.phrases || []);
    self.postMessage({ type: 'ready', count: phrases.length });
  } else if (msg.type === 'query') {
    const t0 = performance.now();
    const suggestion = queryLocal(msg.text || '');
    const us = Math.round((performance.now() - t0) * 1000);
    self.postMessage({
      type: 'result',
      seq: msg.seq,
      text: msg.text,
      suggestion,
      us
    });
  }
};
`

// ── Shared Singleton Engine (Events + Worker + Fast Small-Model Race) ────────

const listeners = new Set()
let currentState = {
  enabled: true,
  suggestion: '',
  direction: 'ltr',
  source: '',
  latencyLabel: '',
  modelName: '',
  activeText: ''
}

function setEngineState(patch) {
  currentState = { ...currentState, ...patch }
  for (const fn of listeners) {
    try {
      fn(currentState)
    } catch {
      // ignore listener errors
    }
  }
}

function splitFirstWordSuffix(suggestion) {
  if (!suggestion) return { wordToInsert: '', remaining: '' }
  const m = suggestion.match(/^(\s*\S+)(.*)$/)
  if (!m) return { wordToInsert: suggestion, remaining: '' }
  return {
    wordToInsert: m[1],
    remaining: m[2] || ''
  }
}

// ── React Bar Rendered in COMPOSER_AREAS.top (Zero Editor DOM Mutation) ──────

function AutocompleteBar() {
  const [snap, setSnap] = useState(currentState)

  useEffect(() => {
    listeners.add(setSnap)
    return () => listeners.delete(setSnap)
  }, [])

  if (!snap.enabled || !snap.suggestion) {
    return null
  }

  const isRtl = snap.direction === 'rtl'
  const acceptKeyLabel = isRtl ? '← ArrowLeft' : '→ ArrowRight'
  const wordKeyLabel = isRtl ? 'Ctrl+← Word' : 'Ctrl+→ Word'

  return jsx('div', {
    dir: isRtl ? 'rtl' : 'ltr',
    className: cn(
      'flex items-center justify-between gap-2 rounded-lg border border-(--ui-stroke-secondary)/70 bg-(--ui-bg-secondary)/60 px-2.5 py-1 text-xs select-none'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden',
        children: [
          jsx(icons.Zap, { className: 'size-3 shrink-0 text-(--ui-accent)' }),
          jsx('span', {
            className: 'truncate font-mono text-[0.72rem] text-(--ui-text-tertiary)',
            children: snap.activeText.slice(-42)
          }),
          jsx('span', {
            className: 'truncate font-mono text-[0.74rem] font-semibold text-(--ui-accent)',
            children: snap.suggestion
          })
        ]
      }),
      jsxs('div', {
        dir: 'ltr',
        className: 'flex items-center gap-1.5 shrink-0 font-mono text-[0.62rem] text-(--ui-text-tertiary)',
        children: [
          jsx('span', {
            className: cn(
              'rounded px-1 py-0.2',
              snap.source === 'worker'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-sky-500/15 text-sky-400'
            ),
            children:
              snap.source === 'worker'
                ? `⚡ Worker ${snap.latencyLabel || '<1ms'}`
                : `⚡ ${snap.modelName?.split('/').pop() || 'fast'} · ${snap.latencyLabel || ''}`
          }),
          jsx('span', {
            className: 'rounded border border-(--ui-stroke-secondary) bg-(--ui-bg-primary)/70 px-1.5 py-0.2 text-foreground',
            children: acceptKeyLabel
          }),
          jsx('span', {
            className: 'hidden sm:inline rounded border border-(--ui-stroke-secondary)/60 px-1 py-0.2 text-(--ui-text-quaternary)',
            children: wordKeyLabel
          }),
          jsx('span', {
            className: 'hidden md:inline text-(--ui-text-quaternary)',
            children: 'Tab'
          })
        ]
      })
    ]
  })
}

function AutocompleteStatusChip({ ctx }) {
  const [snap, setSnap] = useState(currentState)

  useEffect(() => {
    listeners.add(setSnap)
    return () => listeners.delete(setSnap)
  }, [])

  const enabled = snap.enabled
  const isRtl = snap.direction === 'rtl'

  return jsx(Tip, {
    label: enabled
      ? `Prompt Autocomplete ON — Implied ${isRtl ? 'RTL (←)' : 'LTR (→)'} · Click to toggle`
      : 'Prompt Autocomplete OFF — Click to enable',
    children: jsxs('button', {
      type: 'button',
      onClick: () => {
        haptic('tap')
        const next = !enabled
        try {
          ctx.storage?.set?.('enabled', next)
        } catch {
          // ignore
        }
        setEngineState({ enabled: next, ...(next ? {} : { suggestion: '' }) })
      },
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-mono tabular-nums transition-colors shrink-0',
        enabled
          ? 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          : 'text-(--ui-text-quaternary) opacity-60 hover:opacity-100'
      ),
      children: [
        jsx(StatusDot, { tone: enabled ? 'success' : 'neutral' }),
        jsx('span', { children: isRtl ? 'AC←' : 'AC→' }),
        snap.latencyLabel &&
          enabled &&
          jsx('span', {
            className: 'hidden lg:inline text-[0.6rem] text-(--ui-text-quaternary)',
            children: snap.latencyLabel
          })
      ]
    })
  })
}

// ── Plugin Registration ──────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Fast Prompt Autocomplete (Implied LTR/RTL)',
  description: 'Zero-DOM-lag sentence completion: <1ms WebWorker history Trie + ~500ms small-model race with implied LTR (→) / RTL (←) arrow acceptance.',
  defaultEnabled: true,
  register(ctx) {
    try {
      const savedEnabled = ctx.storage?.get?.('enabled')
      if (typeof savedEnabled === 'boolean') {
        currentState.enabled = savedEnabled
      }
    } catch {
      // ignore
    }

    let worker = null
    let seq = 0
    let llmTimer = null
    let activeEditor = null

    try {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      worker = new Worker(url)
      URL.revokeObjectURL(url)

      worker.onmessage = ev => {
        const msg = ev.data || {}
        if (msg.type === 'result' && msg.seq === seq) {
          if (msg.suggestion) {
            setEngineState({
              suggestion: msg.suggestion,
              source: 'worker',
              latencyLabel: '<1ms',
              modelName: 'WebWorker Trie'
            })
          }
        }
      }

      ctx
        .rest('/corpus')
        .then(data => {
          if (data?.phrases && worker) {
            worker.postMessage({ type: 'init', phrases: data.phrases })
          }
        })
        .catch(() => {})
    } catch {
      worker = null
    }

    const clearSuggestion = () => {
      if (llmTimer) {
        clearTimeout(llmTimer)
        llmTimer = null
      }
      if (currentState.suggestion) {
        setEngineState({ suggestion: '' })
      }
    }

    const requestFastModelCompletion = (text, direction, currentSeq) => {
      if (!currentState.enabled) return

      const t0 = performance.now()
      ctx
        .rest('/complete', {
          method: 'POST',
          body: { prefix: text, direction },
          timeoutMs: 2200
        })
        .then(data => {
          if (currentSeq !== seq) return
          if (!data?.ok || !data?.suggestion) return
          const ms = Math.round(performance.now() - t0)
          const needsLeadingSpace =
            !/\s$/.test(text) &&
            !data.suggestion.startsWith(' ') &&
            !/^[.,!?;:]/.test(data.suggestion)
          const formatted = (needsLeadingSpace ? ' ' : '') + data.suggestion
          setEngineState({
            suggestion: formatted,
            source: 'model',
            latencyLabel: `${data.ms || ms}ms`,
            modelName: data.model || 'fast-small'
          })
        })
        .catch(() => {})
    }

    const onDocumentInput = ev => {
      if (!currentState.enabled) return
      const target = ev.target
      if (!target || target.getAttribute?.('role') !== 'textbox' || !target.isContentEditable) {
        return
      }
      activeEditor = target

      if (!isCaretAtEnd(target)) {
        clearSuggestion()
        return
      }

      const text = target.innerText || ''
      const trimmed = text.trim()
      if (trimmed.length < 3 || trimmed.startsWith('/') || trimmed.startsWith('@')) {
        clearSuggestion()
        return
      }

      const direction = inferDirection(text)
      const mySeq = ++seq

      if (currentState.suggestion && text.startsWith(currentState.activeText) && text.length > currentState.activeText.length) {
        const typedDelta = text.slice(currentState.activeText.length)
        if (currentState.suggestion.toLowerCase().startsWith(typedDelta.toLowerCase())) {
          const nextSug = currentState.suggestion.slice(typedDelta.length)
          setEngineState({
            activeText: text,
            direction,
            suggestion: nextSug,
            latencyLabel: '0ms'
          })
          if (nextSug.trim().length > 2) {
            return
          }
        }
      }

      setEngineState({
        activeText: text,
        direction,
        suggestion: ''
      })

      if (worker) {
        worker.postMessage({ type: 'query', seq: mySeq, text })
      }

      if (llmTimer) clearTimeout(llmTimer)
      llmTimer = setTimeout(() => {
        if (mySeq !== seq) return
        if (!currentState.suggestion) {
          requestFastModelCompletion(text, direction, mySeq)
        }
      }, 90)
    }

    const acceptCompletion = (mode = 'full') => {
      const sug = currentState.suggestion
      if (!sug) return false

      const { wordToInsert, remaining } =
        mode === 'word'
          ? splitFirstWordSuffix(sug)
          : { wordToInsert: sug, remaining: '' }

      if (!wordToInsert) return false
      haptic('tap')

      const nextFullDraft = `${currentState.activeText}${wordToInsert}`
      void host.composer.setDraft(null, nextFullDraft)

      setEngineState({
        activeText: nextFullDraft,
        suggestion: remaining
      })
      return true
    }

    const onDocumentKeyDown = ev => {
      if (!currentState.enabled) return
      if (!currentState.suggestion) return

      const target = ev.target
      if (!target || target.getAttribute?.('role') !== 'textbox' || !target.isContentEditable) {
        return
      }

      if (ev.key === 'Escape') {
        clearSuggestion()
        return
      }

      if (!isCaretAtEnd(target)) {
        clearSuggestion()
        return
      }

      const isRtl = currentState.direction === 'rtl'
      const forwardArrow = isRtl ? 'ArrowLeft' : 'ArrowRight'

      if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault()
        ev.stopPropagation()
        acceptCompletion('full')
        return
      }

      if (ev.key === forwardArrow && !ev.altKey && !ev.shiftKey) {
        ev.preventDefault()
        ev.stopPropagation()
        if (ev.ctrlKey || ev.metaKey) {
          acceptCompletion('word')
        } else {
          acceptCompletion('full')
        }
      }
    }

    const onDocumentFocusOut = ev => {
      if (ev.target === activeEditor) {
        clearSuggestion()
      }
    }

    document.addEventListener('input', onDocumentInput, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)
    document.addEventListener('focusout', onDocumentFocusOut, true)

    ctx.onDispose(() => {
      document.removeEventListener('input', onDocumentInput, true)
      document.removeEventListener('keydown', onDocumentKeyDown, true)
      document.removeEventListener('focusout', onDocumentFocusOut, true)
      clearSuggestion()
      if (worker) {
        worker.terminate()
        worker = null
      }
    })

    ctx.registerMany([
      {
        id: 'composer-top-bar',
        area: COMPOSER_AREAS.top,
        order: 5,
        render: () => jsx(AutocompleteBar, {})
      },
      {
        id: 'statusbar-chip',
        area: STATUSBAR_AREAS.right,
        order: 45,
        render: () => jsx(AutocompleteStatusChip, { ctx })
      }
    ])
  }
}
