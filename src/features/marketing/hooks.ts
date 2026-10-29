import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { archiveMarketingDraft, getMarketingDrafts, getMarketingResults, saveMarketingDraft, type DraftInput, type MarketingDraft } from "./api";

export const marketingKeys = {
  drafts: (unitId: string) => ["marketing", unitId, "drafts"] as const,
  results: (unitId: string, from: string, to: string) => ["marketing", unitId, "results", from, to] as const,
};
export function isMarketingPeriodValid(from: string, to: string) {
  return !!from && !!to && from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 <= 365;
}
export function useMarketingDrafts(unitId: string) {
  return useQuery({ queryKey: marketingKeys.drafts(unitId), queryFn: () => getMarketingDrafts(unitId), enabled: !!unitId });
}
export function useMarketingResults(unitId: string, from: string, to: string) {
  return useQuery({ queryKey: marketingKeys.results(unitId, from, to), queryFn: () => getMarketingResults(unitId, from, to), enabled: !!unitId && isMarketingPeriodValid(from, to) });
}
export function useMarketingMutations(unitId: string) {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: marketingKeys.drafts(unitId) });
  const save = useMutation({ mutationFn: ({ input, draft }: { input: DraftInput; draft?: MarketingDraft }) => saveMarketingDraft(unitId, input, draft), onSuccess: invalidate, onError: invalidate });
  const archive = useMutation({ mutationFn: archiveMarketingDraft, onSuccess: invalidate, onError: invalidate });
  return { save, archive };
}
