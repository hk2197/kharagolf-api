import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Send, X, ChevronRight } from 'lucide-react';

type Announcement = { id: number; text: string; author: string; at: string };

interface LiveMessagePanelProps {
  streamUrl: string;
  postUrl: string;
  authorName?: string;
  isAdmin?: boolean;
}

export function LiveMessagePanel({ streamUrl, postUrl, authorName = 'Admin', isAdmin = false }: LiveMessagePanelProps) {
  const [messages, setMessages] = useState<Announcement[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (esRef.current) { esRef.current.close(); }
    const es = new EventSource(streamUrl, { withCredentials: true });
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data) as { type: string; data?: Announcement };
        if (payload.type === 'connected') { setConnected(true); }
        if (payload.type === 'announcement' && payload.data) {
          setMessages(prev => {
            if (prev.some(m => m.id === payload.data!.id)) return prev;
            return [...prev, payload.data!];
          });
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      setConnected(false);
      // Cancel any prior pending reconnect before scheduling a new one
      if (reconnectTimerRef.current != null) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };
  }, [streamUrl]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      // Cancel pending reconnect so it cannot fire after unmount
      if (reconnectTimerRef.current != null) clearTimeout(reconnectTimerRef.current);
      esRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    if (!collapsed) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, collapsed]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setSending(true);
    try {
      await fetch(postUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, author: authorName }),
      });
      setInput('');
    } finally {
      setSending(false);
    }
  };

  const fmt = (at: string) => {
    const d = new Date(at);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-muted-foreground hover:text-white hover:bg-white/10 transition-all"
          title="Open announcements"
        >
          <MessageSquare className="w-4 h-4" />
          {messages.length > 0 && (
            <span className="bg-orange-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
              {messages.length > 9 ? '9+' : messages.length}
            </span>
          )}
          <ChevronRight className="w-3 h-3 opacity-50" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-72 min-w-[272px] glass-card rounded-2xl border border-white/10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}`} />
          <span className="font-semibold text-white text-sm">Announcements</span>
          {messages.length > 0 && (
            <span className="text-xs text-muted-foreground">({messages.length})</span>
          )}
        </div>
        <button onClick={() => setCollapsed(true)} className="text-muted-foreground hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto max-h-64 min-h-[120px] p-3 space-y-2">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 text-center py-6">No announcements yet.</p>
        ) : (
          messages.map(m => (
            <div key={m.id} className="rounded-xl bg-white/[0.04] border border-white/[0.06] px-3 py-2">
              <p className="text-sm text-white leading-snug">{m.text}</p>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-orange-400 font-medium">{m.author}</span>
                <span className="text-xs text-muted-foreground/60">{fmt(m.at)}</span>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {isAdmin && (
        <div className="border-t border-white/10 p-3 flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Send announcement..."
            className="flex-1 text-sm bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-orange-400/50 min-w-0"
            disabled={sending}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            className="p-2 rounded-lg bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
