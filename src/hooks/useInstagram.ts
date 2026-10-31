import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  connectCallback,
  connectStart,
  disconnectInstagram,
  readInstagramAccount,
  readInstagramDiagnostics,
  readInstagramSettings,
  readUnitModules,
  resubscribeInstagram,
  setUnitModule,
  updateInstagramDm,
} from "@/features/instagram/api";
import { instagramKeys } from "@/features/instagram/types";

export function useInstagramModule(unitId: string | undefined) {
  return useQuery({
    queryKey: instagramKeys.module(unitId ?? ""),
    queryFn: () => readUnitModules(unitId!),
    enabled: !!unitId,
  });
}

export function useInstagramAccount(unitId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: instagramKeys.account(unitId ?? ""),
    queryFn: () => readInstagramAccount(unitId!),
    enabled: !!unitId && enabled,
    retry: false,
  });
}

export function useInstagramSettings(unitId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: instagramKeys.settings(unitId ?? ""),
    queryFn: () => readInstagramSettings(unitId!),
    enabled: !!unitId && enabled,
  });
}

export function useInstagramDiagnostics(unitId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: instagramKeys.diagnostics(unitId ?? ""),
    queryFn: () => readInstagramDiagnostics(unitId!),
    enabled: !!unitId && enabled,
    retry: false,
  });
}

export function useSetUnitModule(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (active: boolean) => setUnitModule(unitId, active),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: instagramKeys.module(unitId) });
      qc.invalidateQueries({ queryKey: instagramKeys.settings(unitId) });
      qc.invalidateQueries({ queryKey: instagramKeys.account(unitId) });
    },
  });
}

export function useUpdateInstagramDm(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => updateInstagramDm(unitId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: instagramKeys.settings(unitId) }),
  });
}

export function useConnectInstagramStart(unitId: string) {
  return useMutation({ mutationFn: () => connectStart(unitId) });
}

/** Callback não tem unitId: a unidade vem do state; invalida todas as contas. */
export function useConnectInstagramCallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { code: string; state: string }) => connectCallback(vars.code, vars.state),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instagram-account"] });
      qc.invalidateQueries({ queryKey: ["instagram-settings"] });
    },
  });
}

export function useDisconnectInstagram(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectInstagram(unitId),
    onSuccess: () => qc.invalidateQueries({ queryKey: instagramKeys.account(unitId) }),
  });
}

export function useResubscribeInstagram(unitId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => resubscribeInstagram(unitId),
    onSuccess: () => qc.invalidateQueries({ queryKey: instagramKeys.account(unitId) }),
  });
}
