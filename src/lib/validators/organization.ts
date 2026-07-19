import { z } from "zod";
import { isValidTaxId, normalizeTaxId } from "@/lib/tax-id";

const slugRegex = /^[a-z0-9-]+$/;

export const createOrganizationSchema = z.object({
  org_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres."),
  org_slug: z
    .string()
    .min(2)
    .max(60)
    .regex(slugRegex, "Apenas letras minúsculas, números e hífens.")
    .transform((v) => v.toLowerCase()),
  unit_name: z.string().min(2, "Nome da unidade deve ter ao menos 2 caracteres."),
  unit_slug: z
    .string()
    .min(2)
    .max(60)
    .regex(slugRegex, "Apenas letras minúsculas, números e hífens.")
    .transform((v) => v.toLowerCase()),
  unit_timezone: z.string().default("America/Sao_Paulo"),
  owner_email: z.string().email("E-mail inválido."),
  owner_password: z.string().min(10, "Senha deve ter ao menos 10 caracteres."),
  // CPF/CNPJ é obrigatório para criar cliente no Asaas (§9 do doc 03). Sem ele,
  // o checkout falha antes da primeira chamada de API — melhor barrar aqui.
  tax_id: z
    .string()
    .min(1, "CPF/CNPJ é obrigatório.")
    .refine(isValidTaxId, "CPF/CNPJ inválido — verifique os dígitos.")
    .transform(normalizeTaxId),
  // Canal de cobrança da org. Antes desta fase nascia nulo em toda org, o que
  // deixava os lembretes de billing sem destinatário.
  billing_email: z.string().email("E-mail de cobrança inválido."),
});

export const updateOrganizationSchema = z.object({
  org_id: z.string().uuid(),
  org_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres."),
  // `plan` (coluna legada organizations.plan) saiu daqui na Fase 3 da migração
  // billing-asaas. O plano contratado vive em billing_subscriptions →
  // billing_plans; a coluna antiga é texto livre sem relação com o catálogo.
  // manage-organizations ainda aceita o campo (guardado por `if (plan)`), então
  // remover daqui não quebra a EF — só para de oferecer a edição.
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
