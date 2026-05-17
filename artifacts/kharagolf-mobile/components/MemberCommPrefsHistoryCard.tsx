import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { getApiUrl } from "@/utils/api";
import { NotifPrefsAuditTimeline } from "./NotifPrefsAuditTimeline";

const GOLD = "#C9A84C";

interface OrgMember {
  userId: number;
  displayName: string | null;
  username: string;
  email: string | null;
  role: string;
}

/**
 * Mobile admin card that lets an org admin look up a member and see the same
 * `comm_prefs` chronological audit timeline that the web admin Players page
 * surfaces inline next to each expanded member row (Task #1853 / #1505).
 *
 * The card self-hides on 401/403 responses from the members listing so
 * non-admins never see an empty shell, mirroring the existing
 * `TieBreakEmailOptOutsCard` / `ScheduleChangeOptOutsCard` pattern. The
 * embedded `NotifPrefsAuditTimeline` does its own 401/403 self-hide as
 * defense-in-depth.
 *
 * Hits the same listing endpoint as the web Players page:
 *   GET /api/organizations/:orgId/members
 * The audit log itself is loaded by `NotifPrefsAuditTimeline` from
 *   GET /api/organizations/:orgId/members/:userId/audit-log?entity=comm_prefs
 */
export function MemberCommPrefsHistoryCard({
  orgId,
  token,
}: {
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  useEffect(() => {
    if (!orgId || !token) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setAllowed(true);
    setMembers([]);
    setSelectedUserId(null);
    setSearch("");
    fetch(getApiUrl(`/organizations/${orgId}/members`), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = (await r.json()) as OrgMember[];
        // Sort by display name for predictable picker order — the listing
        // endpoint sorts by joinedAt, which isn't useful here.
        const sorted = [...data].sort((a, b) =>
          (a.displayName ?? a.username ?? "").localeCompare(b.displayName ?? b.username ?? ""),
        );
        setMembers(sorted);
      })
      .catch(() => { /* best-effort — leave loading off */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId, token]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members.slice(0, 8);
    return members
      .filter((m) => {
        const name = (m.displayName ?? m.username ?? "").toLowerCase();
        const email = (m.email ?? "").toLowerCase();
        return name.includes(q) || email.includes(q);
      })
      .slice(0, 12);
  }, [members, search]);

  const selectedMember = useMemo(
    () => members.find((m) => m.userId === selectedUserId) ?? null,
    [members, selectedUserId],
  );

  if (!orgId || !token) return null;
  if (!allowed) return null;

  return (
    <View style={styles.card} testID="card-member-comm-prefs-history">
      <View style={styles.headerRow}>
        <Feather name="clock" size={16} color={GOLD} />
        <Text style={styles.title}>Notification preference history</Text>
      </View>
      <Text style={styles.subtitle}>
        Look up a member to see who changed their notification preferences
        and when. Mirrors the timeline shown on the web Players page.
      </Text>

      <View style={styles.searchRow}>
        <Feather name="search" size={14} color={Colors.muted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search members by name or email"
          placeholderTextColor={Colors.muted}
          style={styles.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          testID="input-member-comm-prefs-search"
        />
      </View>

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={GOLD} />
          <Text style={styles.loadingText}>Loading members…</Text>
        </View>
      ) : members.length === 0 ? (
        <Text style={styles.emptyText} testID="text-member-comm-prefs-no-members">
          No members found in this organization.
        </Text>
      ) : (
        <View style={styles.list}>
          {filtered.map((m) => {
            const label = m.displayName ?? m.username;
            const isSelected = m.userId === selectedUserId;
            return (
              <TouchableOpacity
                key={m.userId}
                style={[styles.memberRow, isSelected && styles.memberRowActive]}
                onPress={() => setSelectedUserId(isSelected ? null : m.userId)}
                testID={`button-member-comm-prefs-pick-${m.userId}`}
                accessibilityRole="button"
                accessibilityLabel={`View notification preference history for ${label}`}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.memberName} numberOfLines={1}>{label}</Text>
                  {m.email ? (
                    <Text style={styles.memberEmail} numberOfLines={1}>{m.email}</Text>
                  ) : null}
                </View>
                <Feather
                  name={isSelected ? "chevron-down" : "chevron-right"}
                  size={16}
                  color={Colors.muted}
                />
              </TouchableOpacity>
            );
          })}
          {filtered.length === 0 ? (
            <Text style={styles.emptyText} testID="text-member-comm-prefs-no-matches">
              No members match “{search.trim()}”.
            </Text>
          ) : null}
        </View>
      )}

      {selectedMember ? (
        <View style={styles.timelineWrap} testID={`section-member-comm-prefs-timeline-${selectedMember.userId}`}>
          <Text style={styles.selectedHeader}>
            {selectedMember.displayName ?? selectedMember.username}
          </Text>
          <NotifPrefsAuditTimeline
            orgId={orgId}
            userId={selectedMember.userId}
            token={token}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 6, lineHeight: 17 },
  searchRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: Colors.background,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 13,
    padding: 0,
  },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 12 },
  loadingText: { color: Colors.muted, fontSize: 12 },
  emptyText: { color: Colors.muted, fontSize: 12, marginTop: 10 },
  list: { marginTop: 10, gap: 6 },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    backgroundColor: Colors.background,
  },
  memberRowActive: { borderColor: GOLD, backgroundColor: Colors.cardHighlight },
  memberName: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  memberEmail: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  timelineWrap: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  selectedHeader: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
});
