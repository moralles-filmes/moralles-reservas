import { z } from "zod";

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
});

export const updateOrganizationSchema = z.object({
  org_id: z.string().uuid(),
  org_name: z.string().min(2, "Nome deve ter ao menos 2 caracteres."),
  plan: z.string().optional(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
