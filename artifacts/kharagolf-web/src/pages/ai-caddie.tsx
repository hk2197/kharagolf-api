/**
 * AI Caddie chat page (web parity for Task #842).
 * Streams responses from `POST /api/portal/caddie/ask` (SSE) and keeps a short
 * conversation history that is sent back as the `history` array on each turn.
 * After every assistant turn we surface a "Based on your last N shots /
 * N rounds (M shots tracked)" attribution chip from the final SSE event,
 * mirroring the mobile screen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Cpu, Database, RefreshCw, Send, Square, ChevronLeft, Loader2 } from 'lucide-react';
import { markdownToHtml } from '@/lib/markdown';

const MAX_HISTORY = 8;
const MAX_MESSAGES = 50;

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  context?: {
    shots: number;
    rounds: number;
    mode?: 'shots' | 'rounds';
    totalTrackedShots?: number;
  };
  error?: string;
}

const STARTER_PROMPTS = [
  'What should I work on this week?',
  'What club from 150 yards into the wind?',
  'How is my approach play trending?',
];

function formatContext(ctx: NonNullable<ChatMessage['context']>): string | null {
  const fmt = (n: number) => n.toLocaleString();
  if (ctx.mode === 'rounds') {
    const tracked =
      ctx.totalTrackedShots && ctx.totalTrackedShots > 0
        ? ` (${fmt(ctx.totalTrackedShots)} shots tracked)`
        : '';
    if (ctx.rounds > 0) {
      return `Based on your last ${fmt(ctx.rounds)} round${ctx.rounds === 1 ? '' : 's'}${tracked}`;
    }
    return tracked ? `Based on ${fmt(ctx.totalTrackedShots ?? 0)} tracked shots` : null;
  }
  if (ctx.mode === 'shots' || (!ctx.mode && ctx.shots > 0)) {
    if (ctx.shots > 0) {
      return `Based on your last ${fmt(ctx.shots)} shot${ctx.shots === 1 ? '' : 's'}`;
    }
  }
  if (!ctx.mode && ctx.rounds > 0) {
    return `Based on your last ${fmt(ctx.rounds)} round${ctx.rounds === 1 ? '' : 's'}`;
  }
  return null;
}

export default function AiCaddiePage() {
  const [, navigate] = useLocation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks whether the initial server load has completed so the persistence
  // effect doesn't immediately PUT an empty array on first render and wipe
  // a transcript that lives on the server from another device.
  const hydratedRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Load the player's saved transcript from the server on open so the
  // conversation follows them across devices (Task #988).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portal/caddie/history', {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as { messages?: unknown };
        if (cancelled) return;
        const remote = Array.isArray(data?.messages) ? data.messages : [];
        const cleaned: ChatMessage[] = [];
        for (const raw of remote) {
          if (!raw || typeof raw !== 'object') continue;
          const m = raw as Record<string, unknown>;
          if (typeof m.id !== 'string' || typeof m.content !== 'string') continue;
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          const out: ChatMessage = {
            id: m.id,
            role: m.role,
            content: m.content,
          };
          if (m.context && typeof m.context === 'object') {
            const c = m.context as Record<string, unknown>;
            out.context = {
              shots: typeof c.shots === 'number' ? c.shots : 0,
              rounds: typeof c.rounds === 'number' ? c.rounds : 0,
              mode: c.mode === 'shots' || c.mode === 'rounds' ? c.mode : undefined,
              totalTrackedShots:
                typeof c.totalTrackedShots === 'number' ? c.totalTrackedShots : undefined,
            };
          }
          if (typeof m.error === 'string') out.error = m.error;
          cleaned.push(out);
        }
        // Only seed from the server if the user hasn't already started a
        // turn while the GET was in flight; otherwise we'd clobber that
        // local message. The next PUT will sync the new turn anyway.
        setMessages(prev => (prev.length === 0 ? cleaned.slice(-MAX_MESSAGES) : prev));
      } catch {
        // Network error — start with an empty transcript.
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setHistoryLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the transcript to the server after each change so chats started on
  // a phone show up on the desktop and vice-versa. Skipped while streaming —
  // we PUT the final assistant message after the stream completes via the
  // `messages`/`streaming` dependency edge.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (streaming) return;
    const controller = new AbortController();
    void fetch('/api/portal/caddie/history', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-MAX_MESSAGES) }),
      signal: controller.signal,
    }).catch(() => {
      // Best-effort — a future turn will resync via last-write-wins.
    });
    return () => controller.abort();
  }, [messages, streaming]);

  const send = useCallback(
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || streaming) return;

      const assistantId = `a-${Date.now()}`;
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: question,
      };
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
      };

      const historyPayload = messages
        .filter(m => !m.error && m.content.trim().length > 0)
        .slice(-MAX_HISTORY)
        .map(m => ({ role: m.role, content: m.content }));

      setMessages(prev => [...prev, userMsg, assistantMsg].slice(-MAX_MESSAGES));
      setInput('');
      setStreaming(true);

      const updateAssistant = (mutator: (m: ChatMessage) => ChatMessage) => {
        setMessages(prev => prev.map(m => (m.id === assistantId ? mutator(m) : m)));
      };

      const controller = new AbortController();
      abortRef.current = controller;

      let buffer = '';
      const processBuffer = () => {
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payload = dataLines.join('\n');
          try {
            const evt = JSON.parse(payload) as {
              content?: string;
              done?: boolean;
              contextShots?: number;
              contextRounds?: number;
              contextMode?: 'shots' | 'rounds';
              totalTrackedShots?: number;
              error?: string;
            };
            if (evt.error) {
              updateAssistant(m => ({ ...m, error: evt.error }));
            } else if (typeof evt.content === 'string') {
              updateAssistant(m => ({ ...m, content: m.content + evt.content }));
            } else if (evt.done) {
              updateAssistant(m => ({
                ...m,
                context: {
                  shots: evt.contextShots ?? 0,
                  rounds: evt.contextRounds ?? 0,
                  mode: evt.contextMode,
                  totalTrackedShots: evt.totalTrackedShots,
                },
              }));
            }
          } catch {
            // ignore malformed chunks
          }
        }
      };

      try {
        const res = await fetch('/api/portal/caddie/ask', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ question, history: historyPayload }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let msg = `Request failed (${res.status}).`;
          try {
            const j = await res.json();
            if (j?.error) msg = String(j.error);
          } catch {}
          updateAssistant(m => ({ ...m, error: msg }));
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          updateAssistant(m => ({ ...m, error: 'Streaming not supported.' }));
          return;
        }
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            processBuffer();
          }
        }
        // drain any final bytes
        buffer += decoder.decode();
        processBuffer();
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === 'AbortError') {
          // user-initiated stop
        } else {
          updateAssistant(m => ({
            ...m,
            error: m.error ?? 'Network error. Please try again.',
          }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, streaming],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    if (messages.length === 0) return;
    if (window.confirm('Clear AI Caddie chat history?')) {
      abortRef.current?.abort();
      setMessages([]);
      // Wipe the remote copy so the cleared state syncs to other devices.
      void fetch('/api/portal/caddie/history', {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => {
        // Best-effort — the next PUT (an empty array) will overwrite anyway.
      });
    }
  }, [messages.length]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(input);
      }
    },
    [send, input],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)] min-h-[600px] -m-4 md:-m-6 lg:-m-8">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 flex-shrink-0">
        <button
          onClick={() => navigate('/')}
          className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-white transition-colors"
          aria-label="Back"
          data-testid="ai-caddie-back"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-base font-semibold text-white">Ask the AI Caddie</h1>
          <p className="text-[11px] text-muted-foreground">
            Personalised to your shot history
          </p>
        </div>
        <button
          onClick={reset}
          disabled={messages.length === 0}
          className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Clear chat"
          data-testid="ai-caddie-clear"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {historyLoading && messages.length === 0 && (
            <div
              className="flex flex-col items-center text-center pt-10 px-3 gap-3"
              data-testid="ai-caddie-history-loading"
            >
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Loading your conversation…</p>
            </div>
          )}

          {!historyLoading && messages.length === 0 && (
            <div className="flex flex-col items-center text-center pt-10 px-3 gap-3">
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/40 flex items-center justify-center">
                <Cpu className="w-7 h-7 text-primary" />
              </div>
              <h2 className="text-lg font-bold text-white">Your AI Caddie</h2>
              <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
                Ask anything about your game — club selection, practice priorities, course
                strategy. Answers are grounded in your recent shots and strokes-gained data.
              </p>
              <div className="w-full max-w-md flex flex-col gap-2 mt-2">
                {STARTER_PROMPTS.map(p => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    className="text-left text-sm text-white bg-white/5 border border-primary/25 rounded-lg py-3 px-3.5 hover:bg-white/10 transition-colors"
                    data-testid={`ai-caddie-starter-${p.slice(0, 12)}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(m => (
            <MessageBubble key={m.id} message={m} streaming={streaming} />
          ))}

          {streaming &&
            messages[messages.length - 1]?.role === 'assistant' &&
            messages[messages.length - 1]?.content === '' && (
              <div className="self-start flex items-center gap-2 max-w-[85%] bg-white/5 border border-white/10 text-white px-3 py-2.5 rounded-2xl rounded-bl-sm">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-sm">Thinking…</span>
              </div>
            )}
        </div>
      </div>

      <div className="border-t border-white/5 px-4 py-3 flex-shrink-0">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming}
            placeholder="Ask about your game…"
            aria-label="Message AI Caddie"
            rows={1}
            className="flex-1 resize-none min-h-[40px] max-h-32 bg-white/5 border border-white/10 rounded-2xl px-4 py-2.5 text-sm text-white placeholder:text-white/35 focus:outline-none focus:border-primary/50"
            data-testid="ai-caddie-input"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center flex-shrink-0"
              data-testid="ai-caddie-stop"
              aria-label="Stop"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={input.trim().length === 0}
              className="w-10 h-10 rounded-full bg-primary hover:bg-primary/90 text-black flex items-center justify-center flex-shrink-0 disabled:bg-primary/30 disabled:cursor-not-allowed"
              data-testid="ai-caddie-send"
              aria-label="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  const isUser = message.role === 'user';
  if (!isUser && message.content === '' && !message.error) return null;
  const contextLabel = message.context ? formatContext(message.context) : null;
  const showCursor =
    !isUser && streaming && message.content.length > 0 && !message.context && !message.error;

  const html = useMemo(
    () => (isUser ? '' : markdownToHtml(message.content)),
    [isUser, message.content],
  );

  return (
    <div className={isUser ? 'self-end max-w-[85%]' : 'self-start max-w-[85%]'}>
      <div
        className={
          isUser
            ? 'bg-primary text-black rounded-2xl rounded-br-sm px-3.5 py-2.5'
            : 'bg-white/5 border border-white/10 text-white rounded-2xl rounded-bl-sm px-3.5 py-2.5'
        }
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div
            className="text-sm leading-relaxed ai-caddie-markdown"
            // markdownToHtml escapes user/model text and emits a safe subset
            // (p, h1–h3, ul/ol/li, strong, em, code).
            dangerouslySetInnerHTML={{ __html: html + (showCursor ? ' ▍' : '') }}
            data-testid="ai-caddie-assistant-content"
          />
        )}
        {message.error && (
          <p className="text-xs text-red-300 mt-2" data-testid="ai-caddie-error">
            {message.error}
          </p>
        )}
        {!isUser && contextLabel && (
          <div
            className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full bg-white/5 border border-white/10"
            data-testid="ai-caddie-context-chip"
          >
            <Database className="w-2.5 h-2.5 text-white/55" />
            <span className="text-[10.5px] text-white/65 font-medium">{contextLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
