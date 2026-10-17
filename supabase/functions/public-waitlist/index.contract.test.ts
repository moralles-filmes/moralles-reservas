import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { expect, it } from "vitest";

const source = readFileSync(join(cwd(), "supabase/functions/public-waitlist/index.ts"), "utf8");

it("uses the service-only public wrapper; never calls the legacy RPC directly", () => {
  expect(source).toContain('supabase.rpc("enter_public_waitlist"');
  expect(source).not.toContain('supabase.rpc("enter_waitlist"');
  expect(source).toContain('supabase.rpc("record_public_promotional_opt_in"');
  expect(source).toContain('supabase.rpc("check_public_waitlist_rate_limit"');
  expect(source).not.toContain('supabase.rpc("check_rate_limit"');
});
