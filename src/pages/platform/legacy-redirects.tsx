import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/platform/automacao/:unitSlug` virou `/platform/unidades/:unitSlug`.
 * A query precisa sobreviver: o retorno do onboarding Stripe Connect é montado
 * no servidor (`manage-stripe-accounts`) como `/platform/automacao/<slug>?stripe=complete`.
 */
export function LegacyPlatformUnitRedirect() {
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: `/platform/unidades/${unitSlug ?? ""}`, search, hash }} />;
}
