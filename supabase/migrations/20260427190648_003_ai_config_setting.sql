-- Add default ai_config to settings (provider + model overrides, NO API keys)
insert into settings (key, value) values (
  'ai_config',
  '{
    "provider": "claude",
    "models": {
      "claude": "claude-sonnet-4-6",
      "openai": "gpt-4o",
      "gemini": "gemini-2.0-flash",
      "grok": "grok-3",
      "deepseek": "deepseek-chat"
    }
  }'::jsonb
) on conflict (key) do nothing;
