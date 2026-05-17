/**
 * HoleShotReviewModal — wires the per-hole `<ShotReviewModal>` to the same
 * SG-round React Query the score screen renders the per-hole Strokes Gained
 * card from. When the modal mutates (Add / Edit / Delete), this wrapper
 * refetches `["portal-sg-round", tournamentId, round]` so the per-hole SG
 * number on screen reflects the new shot list immediately.
 *
 * Extracted from `app/(tabs)/score.tsx` (Task #808) so the wiring between
 * the modal's `onMutated` callback and the SG card refresh can be exercised
 * by an automated test without dragging in the full scoring screen's
 * expo-camera / expo-location / background-task imports.
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchPortal } from "@/utils/api";
import ShotReviewModal from "@/components/ShotReviewModal";

interface SGHoleBreakdown {
  holeNumber: number;
  sgPutting: number;
  sgApproach: number;
  sgATG: number;
  sgOTT: number;
  sgTotal: number;
  puttingEstimated?: boolean;
}

interface SGRoundResponse {
  baseline: string;
  round: number;
  shotsTracked: number;
  holes: SGHoleBreakdown[];
  totals: { sgPutting: number; sgApproach: number; sgATG: number; sgOTT: number; sgTotal: number; puttingEstimated?: boolean } | null;
}

export interface HoleShotReviewModalProps {
  visible: boolean;
  onClose: () => void;
  token: string | null;
  tournamentId: number;
  round: number;
  holeNumber: number;
  onShotsRefreshed?: () => void;
}

export default function HoleShotReviewModal({
  visible,
  onClose,
  token,
  tournamentId,
  round,
  holeNumber,
  onShotsRefreshed,
}: HoleShotReviewModalProps) {
  const { refetch: refetchSg } = useQuery<SGRoundResponse>({
    queryKey: ["portal-sg-round", tournamentId, round],
    queryFn: () => fetchPortal<SGRoundResponse>(
      `/sg/round?round=${round}&tournamentId=${tournamentId}`,
      token!,
    ),
    enabled: !!token,
    staleTime: 30 * 1000,
  });

  return (
    <ShotReviewModal
      visible={visible}
      onClose={onClose}
      token={token}
      tournamentId={tournamentId}
      round={round}
      holeNumber={holeNumber}
      onMutated={() => {
        refetchSg().catch(() => {});
        onShotsRefreshed?.();
      }}
    />
  );
}
