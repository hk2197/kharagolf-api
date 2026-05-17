/**
 * AI Caddie chat screen (Task #521).
 * Streams responses from `POST /api/portal/caddie/ask` (SSE) and keeps a short
 * conversation history that is sent back as the `history` array on each turn.
 * After every assistant turn we surface a "context: N shots / M rounds" hint
 * from the final SSE event.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Share } from "react-native";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";
import {
  MarkdownBlock,
  MarkdownInline,
  renderMarkdownBlocks,
} from "@/utils/markdown";
import {
  CADDIE_HISTORY_MAX_MESSAGES,
  clearCaddieHistory,
  loadCaddieHistory,
  saveCaddieHistory,
} from "@/utils/caddieHistory";

const GOLD = "#C9A84C";
const MAX_HISTORY = 8;

type ChatRole = "user" | "assistant";
interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Set on the assistant message when the SSE `done` event arrives. */
  context?: {
    shots: number;
    rounds: number;
    mode?: "shots" | "rounds";
    totalTrackedShots?: number;
  };
  /** Set when the server returned an error for this turn. */
  error?: string;
}

const STARTER_PROMPTS = [
  "What should I work on this week?",
  "What club from 150 yards into the wind?",
  "How is my approach play trending?",
];

export default function AiCaddieScreen() {
  const { token, user } = useAuth();
  const userId = user?.id ?? null;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // Load persisted history for the signed-in player on mount / user change.
  // Clear messages synchronously on every user change so a previous user's
  // chat can never be visible to another account during async hydration.
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setMessages([]);
    if (userId == null) {
      setHydrated(true);
      return () => { cancelled = true; };
    }
    (async () => {
      // Pull from the server first so the transcript follows the player
      // across devices (Task #843); falls back to the AsyncStorage mirror
      // when offline.
      const stored = await loadCaddieHistory(userId, token);
      if (cancelled) return;
      setMessages(stored as ChatMessage[]);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, [userId, token]);

  // Persist history whenever it changes (after hydration, while not streaming).
  useEffect(() => {
    if (!hydrated || userId == null || streaming) return;
    void saveCaddieHistory(userId, messages, token);
  }, [messages, hydrated, userId, streaming, token]);

  // Auto-scroll to the bottom whenever messages change.
  useEffect(() => {
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(id);
  }, [messages]);

  // Cancel any in-flight stream on unmount.
  useEffect(() => () => { xhrRef.current?.abort(); }, []);

  const send = useCallback((rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || streaming || !token || !hydrated) return;

    // Append user turn + an empty assistant turn we will fill as chunks arrive.
    const assistantId = `a-${Date.now()}`;
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: question };
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "" };

    // Build the history payload from the *previous* messages only.
    const historyPayload = messages
      .filter(m => !m.error && m.content.trim().length > 0)
      .slice(-MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }));

    setMessages(prev => [...prev, userMsg, assistantMsg].slice(-CADDIE_HISTORY_MAX_MESSAGES));
    setInput("");
    setStreaming(true);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let lastProcessed = 0;
    let buffer = "";

    const updateAssistant = (mutator: (m: ChatMessage) => ChatMessage) => {
      setMessages(prev => prev.map(m => (m.id === assistantId ? mutator(m) : m)));
    };

    const processBuffer = () => {
      // SSE events are separated by blank lines (\n\n).
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        try {
          const evt = JSON.parse(payload) as {
            content?: string;
            done?: boolean;
            contextShots?: number;
            contextRounds?: number;
            contextMode?: "shots" | "rounds";
            totalTrackedShots?: number;
            error?: string;
          };
          if (evt.error) {
            updateAssistant(m => ({ ...m, error: evt.error }));
          } else if (typeof evt.content === "string") {
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
          // Ignore malformed chunks; keep streaming.
        }
      }
    };

    xhr.open("POST", `${BASE_URL}/api/portal/caddie/ask`, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Accept", "text/event-stream");

    xhr.onprogress = () => {
      const text = xhr.responseText ?? "";
      if (text.length > lastProcessed) {
        buffer += text.slice(lastProcessed);
        lastProcessed = text.length;
        processBuffer();
      }
    };
    xhr.onload = () => {
      // Drain any tail in the buffer.
      const text = xhr.responseText ?? "";
      if (text.length > lastProcessed) {
        buffer += text.slice(lastProcessed);
        lastProcessed = text.length;
      }
      processBuffer();
      if (xhr.status >= 400) {
        updateAssistant(m => ({
          ...m,
          error: m.error ?? `Request failed (${xhr.status}).`,
        }));
      }
      setStreaming(false);
      xhrRef.current = null;
    };
    xhr.onerror = () => {
      updateAssistant(m => ({ ...m, error: "Network error. Please try again." }));
      setStreaming(false);
      xhrRef.current = null;
    };
    xhr.onabort = () => {
      setStreaming(false);
      xhrRef.current = null;
    };

    xhr.send(JSON.stringify({ question, history: historyPayload }));
  }, [messages, streaming, token, hydrated]);

  const stop = useCallback(() => {
    xhrRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    if (messages.length === 0) return;
    const doReset = () => {
      xhrRef.current?.abort();
      setMessages([]);
      if (userId != null) void clearCaddieHistory(userId, token);
    };
    if (Platform.OS === "web") {
      // Alert.alert is a no-op on web; fall back to window.confirm.
      if (typeof window !== "undefined" && window.confirm("Clear AI Caddie chat history?")) {
        doReset();
      }
      return;
    }
    Alert.alert(
      "Clear chat history?",
      "This will remove your AI Caddie conversation on all your devices.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear", style: "destructive", onPress: doReset },
      ],
    );
  }, [messages.length, userId, token]);

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.headerBtn}>
          <Feather name="chevron-left" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Ask the AI Caddie</Text>
          <Text style={styles.headerSubtitle}>Personalised to your shot history</Text>
        </View>
        <TouchableOpacity
          onPress={reset}
          hitSlop={12}
          style={styles.headerBtn}
          disabled={messages.length === 0}
        >
          <Feather
            name="refresh-cw"
            size={18}
            color={messages.length === 0 ? "rgba(255,255,255,0.25)" : "#fff"}
          />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {messages.length === 0 && (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Feather name="cpu" size={28} color={GOLD} />
              </View>
              <Text style={styles.emptyTitle}>Your AI Caddie</Text>
              <Text style={styles.emptyText}>
                Ask anything about your game — club selection, practice priorities, course
                strategy. Answers are grounded in your recent shots and strokes-gained data.
              </Text>
              <View style={styles.starters} accessibilityRole="list">
                {STARTER_PROMPTS.map(p => (
                  <Pressable
                    key={p}
                    style={({ pressed }) => [
                      styles.starter,
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={() => send(p)}
                    accessibilityRole="button"
                    accessibilityLabel={`Ask: ${p}`}
                  >
                    <Text style={styles.starterText}>{p}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {messages.map((m, idx) => {
            const isLast = idx === messages.length - 1;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                streaming={streaming}
                isStreamingThis={streaming && isLast && m.role === "assistant"}
              />
            );
          })}

          {streaming && messages[messages.length - 1]?.role === "assistant"
              && messages[messages.length - 1]?.content === "" && (
            <View style={[styles.bubble, styles.assistantBubble, { flexDirection: "row", gap: 8 }]}>
              <LoadingSpinner size="small" color={GOLD} />
              <Text style={styles.assistantText}>Thinking…</Text>
            </View>
          )}
        </ScrollView>

        {/* Composer */}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Ask about your game…"
            placeholderTextColor="rgba(255,255,255,0.35)"
            multiline
            editable={!streaming}
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
            blurOnSubmit
            accessibilityLabel="Message AI Caddie"
          />
          {streaming ? (
            <TouchableOpacity
              style={[styles.sendBtn, { backgroundColor: "#ef4444" }]}
              onPress={stop}
              accessibilityRole="button"
              accessibilityLabel="Stop generating"
            >
              <Feather name="square" size={18} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.sendBtn,
                { backgroundColor: input.trim().length === 0 ? "rgba(201,168,76,0.35)" : GOLD },
              ]}
              onPress={() => send(input)}
              disabled={input.trim().length === 0}
            >
              <Feather name="arrow-up" size={18} color="#000" />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Format the AI Caddie context metadata into a short attribution string.
 * Returns null if there is nothing meaningful to show (graceful fallback when
 * the server omitted the metadata).
 */
function formatContext(ctx: NonNullable<ChatMessage["context"]>): string | null {
  const fmt = (n: number) => n.toLocaleString();
  if (ctx.mode === "rounds") {
    const tracked = ctx.totalTrackedShots && ctx.totalTrackedShots > 0
      ? ` (${fmt(ctx.totalTrackedShots)} shots tracked)`
      : "";
    if (ctx.rounds > 0) {
      return `Based on your last ${fmt(ctx.rounds)} round${ctx.rounds === 1 ? "" : "s"}${tracked}`;
    }
    return tracked ? `Based on ${fmt(ctx.totalTrackedShots ?? 0)} tracked shots` : null;
  }
  if (ctx.mode === "shots" || (!ctx.mode && ctx.shots > 0)) {
    if (ctx.shots > 0) {
      return `Based on your last ${fmt(ctx.shots)} shot${ctx.shots === 1 ? "" : "s"}`;
    }
  }
  // Backward-compatible fallback: older payloads without `mode` that only
  // report a rounds count should still surface a rounds-based attribution.
  if (!ctx.mode && ctx.rounds > 0) {
    return `Based on your last ${fmt(ctx.rounds)} round${ctx.rounds === 1 ? "" : "s"}`;
  }
  return null;
}

function MessageBubble({
  message,
  streaming,
  isStreamingThis,
}: {
  message: ChatMessage;
  streaming: boolean;
  isStreamingThis: boolean;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  // Don't render an empty assistant placeholder — we show a "Thinking…" row instead.
  if (!isUser && message.content === "" && !message.error) return null;
  const contextLabel = message.context ? formatContext(message.context) : null;

  const showCursor =
    !isUser && streaming && message.content.length > 0 && !message.context && !message.error;

  // Actions are available on assistant bubbles that have content and aren't
  // currently being streamed. Long-press also offers the same actions.
  const canAct = !isUser && message.content.trim().length > 0 && !isStreamingThis;

  const doCopy = useCallback(async () => {
    if (!message.content) return;
    try {
      await Clipboard.setStringAsync(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      Alert.alert("Couldn't copy", "Unable to copy this answer to the clipboard.");
    }
  }, [message.content]);

  const doShare = useCallback(async () => {
    if (!message.content) return;
    try {
      if (Platform.OS === "web") {
        const nav =
          typeof navigator !== "undefined"
            ? (navigator as Navigator & { share?: (data: { text?: string }) => Promise<void> })
            : null;
        if (nav?.share) {
          await nav.share({ text: message.content });
        } else {
          await Clipboard.setStringAsync(message.content);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
        return;
      }
      await Share.share({ message: message.content });
    } catch {
      // User dismissed or sharing unavailable — fall back to clipboard quietly.
      try {
        await Clipboard.setStringAsync(message.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {}
    }
  }, [message.content]);

  const onLongPress = useCallback(() => {
    if (!canAct) return;
    if (Platform.OS === "web") {
      void doCopy();
      return;
    }
    Alert.alert("AI Caddie answer", undefined, [
      { text: "Copy", onPress: () => void doCopy() },
      { text: "Share", onPress: () => void doShare() },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [canAct, doCopy, doShare]);

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
      <Pressable
        onLongPress={canAct ? onLongPress : undefined}
        delayLongPress={350}
        style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
      >
        {isUser ? (
          <Text style={styles.userText}>{message.content}</Text>
        ) : (
          <AssistantMarkdown content={message.content} showCursor={showCursor} />
        )}
        {message.error && (
          <Text style={styles.errorText}>{message.error}</Text>
        )}
        {!isUser && contextLabel && (
          <View style={styles.contextChip}>
            <Feather name="database" size={10} color="rgba(255,255,255,0.55)" />
            <Text style={styles.contextChipText}>{contextLabel}</Text>
          </View>
        )}
        {canAct && (
          <View style={styles.actionsRow}>
            <Pressable
              onPress={doCopy}
              hitSlop={8}
              accessibilityLabel="Copy answer"
              accessibilityRole="button"
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
            >
              <Feather
                name={copied ? "check" : "copy"}
                size={12}
                color="rgba(255,255,255,0.7)"
              />
              <Text style={styles.actionText}>{copied ? "Copied" : "Copy"}</Text>
            </Pressable>
            <Pressable
              onPress={doShare}
              hitSlop={8}
              accessibilityLabel="Share answer"
              accessibilityRole="button"
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
            >
              <Feather name="share-2" size={12} color="rgba(255,255,255,0.7)" />
              <Text style={styles.actionText}>Share</Text>
            </Pressable>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function AssistantMarkdown({ content, showCursor }: { content: string; showCursor: boolean }) {
  const blocks = React.useMemo(() => renderMarkdownBlocks(content), [content]);
  // Append the streaming cursor to the last text-bearing block so it sits at
  // the end of the answer rather than on a fresh line.
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind !== "spacer") { lastTextIdx = i; break; }
  }
  return (
    <View>
      {blocks.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          prev={blocks[i - 1]}
          trailingCursor={showCursor && i === lastTextIdx}
        />
      ))}
    </View>
  );
}

function BlockView({
  block,
  prev,
  trailingCursor,
}: {
  block: MarkdownBlock;
  prev?: MarkdownBlock;
  trailingCursor: boolean;
}) {
  if (block.kind === "spacer") {
    // Collapse multiple spacers and skip a leading spacer.
    if (!prev || prev.kind === "spacer") return null;
    return <View style={styles.mdSpacer} />;
  }
  if (block.kind === "heading") {
    const headingStyle =
      block.level === 1 ? styles.mdH1 : block.level === 2 ? styles.mdH2 : styles.mdH3;
    return (
      <Text style={[styles.assistantText, headingStyle]}>
        <InlineSpans inlines={block.inlines} />
        {trailingCursor ? " ▍" : ""}
      </Text>
    );
  }
  if (block.kind === "list-item") {
    return (
      <View style={styles.mdListRow}>
        <Text style={[styles.assistantText, styles.mdMarker]}>{block.marker}</Text>
        <Text style={[styles.assistantText, styles.mdListText]}>
          <InlineSpans inlines={block.inlines} />
          {trailingCursor ? " ▍" : ""}
        </Text>
      </View>
    );
  }
  if (block.kind === "code-block") {
    return (
      <View style={styles.mdCodeBlockWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.mdCodeBlockInner}
        >
          <Text style={styles.mdCodeBlockText} selectable>
            {block.text}
            {trailingCursor ? " ▍" : ""}
          </Text>
        </ScrollView>
      </View>
    );
  }
  if (block.kind === "table") {
    const colCount = Math.max(
      block.header.length,
      ...block.rows.map(r => r.length),
    );
    const cellAlign = (i: number): "left" | "right" | "center" => {
      const a = block.alignments[i];
      return a === "right" ? "right" : a === "center" ? "center" : "left";
    };
    return (
      <View style={styles.mdTableWrap}>
        <View style={styles.mdTableRow}>
          {Array.from({ length: colCount }).map((_, i) => (
            <View key={i} style={[styles.mdTableCell, styles.mdTableHeaderCell]}>
              <Text style={[styles.assistantText, styles.mdTableHeaderText, { textAlign: cellAlign(i) }]}>
                <InlineSpans inlines={block.header[i] ?? []} />
              </Text>
            </View>
          ))}
        </View>
        {block.rows.map((row, ri) => (
          <View key={ri} style={[styles.mdTableRow, ri === block.rows.length - 1 && styles.mdTableRowLast]}>
            {Array.from({ length: colCount }).map((_, i) => (
              <View key={i} style={styles.mdTableCell}>
                <Text style={[styles.assistantText, styles.mdTableCellText, { textAlign: cellAlign(i) }]}>
                  <InlineSpans inlines={row[i] ?? []} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
  return (
    <Text style={styles.assistantText}>
      <InlineSpans inlines={block.inlines} />
      {trailingCursor ? " ▍" : ""}
    </Text>
  );
}

const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:"];
function openSafeLink(href: string) {
  const lower = href.trim().toLowerCase();
  if (!SAFE_LINK_SCHEMES.some(s => lower.startsWith(s))) return;
  Linking.openURL(href).catch(() => {});
}

function InlineSpans({ inlines }: { inlines: MarkdownInline[] }) {
  return (
    <>
      {inlines.map((inline, i) => {
        switch (inline.type) {
          case "bold":
            return (
              <Text key={i} style={styles.mdBold}>
                {inline.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={styles.mdItalic}>
                {inline.text}
              </Text>
            );
          case "code":
            return (
              <Text key={i} style={styles.mdCode}>
                {inline.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={i}
                style={styles.mdLink}
                onPress={() => openSafeLink(inline.href)}
              >
                {inline.text}
              </Text>
            );
          default:
            return <Text key={i}>{inline.text}</Text>;
        }
      })}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background ?? "#0f1117" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  headerSubtitle: { color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 2 },

  scroll: { padding: 16, paddingBottom: 24, gap: 10 },

  empty: { alignItems: "center", paddingTop: 40, paddingHorizontal: 12, gap: 12 },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: "rgba(201,168,76,0.12)",
    borderWidth: 1, borderColor: "rgba(201,168,76,0.4)",
    alignItems: "center", justifyContent: "center",
  },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  emptyText: { color: "rgba(255,255,255,0.5)", fontSize: 13, textAlign: "center", lineHeight: 19 },
  starters: { width: "100%", gap: 8, marginTop: 8 },
  starter: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1, borderColor: "rgba(201,168,76,0.25)",
    borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14,
  },
  starterText: { color: "#fff", fontSize: 13 },

  bubbleRow: { flexDirection: "row", marginVertical: 2 },
  bubbleRowLeft: { justifyContent: "flex-start" },
  bubbleRowRight: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "85%",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  userBubble: {
    backgroundColor: GOLD,
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderBottomLeftRadius: 4,
  },
  userText: { color: "#000", fontSize: 14, lineHeight: 20 },
  assistantText: { color: "#fff", fontSize: 14, lineHeight: 20 },
  contextChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  contextChipText: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 10.5,
    fontWeight: "500",
  },
  errorText: { color: "#fca5a5", fontSize: 12, marginTop: 6 },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  actionText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 11,
    fontWeight: "500",
  },

  mdSpacer: { height: 6 },
  mdH1: { fontSize: 18, fontWeight: "700", marginTop: 4, marginBottom: 4 },
  mdH2: { fontSize: 16, fontWeight: "700", marginTop: 4, marginBottom: 4 },
  mdH3: { fontSize: 14, fontWeight: "700", marginTop: 4, marginBottom: 2 },
  mdListRow: { flexDirection: "row", alignItems: "flex-start", marginVertical: 1 },
  mdMarker: { width: 18, color: GOLD, fontWeight: "700" },
  mdListText: { flex: 1 },
  mdBold: { fontWeight: "700" },
  mdItalic: { fontStyle: "italic" },
  mdCode: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 13,
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "#f5e9c4",
  },
  mdLink: { color: GOLD, textDecorationLine: "underline" },
  mdCodeBlockWrap: {
    marginVertical: 4,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 8,
  },
  mdCodeBlockInner: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  mdCodeBlockText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12.5,
    lineHeight: 18,
    color: "#f5e9c4",
  },
  mdTableWrap: {
    marginVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    overflow: "hidden",
  },
  mdTableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  mdTableRowLast: { borderBottomWidth: 0 },
  mdTableCell: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.08)",
  },
  mdTableHeaderCell: {
    backgroundColor: "rgba(201,168,76,0.12)",
  },
  mdTableHeaderText: { fontWeight: "700", fontSize: 13 },
  mdTableCellText: { fontSize: 13 },

  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 8 : 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    backgroundColor: Colors.background ?? "#0f1117",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fff",
    fontSize: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
  },
});
