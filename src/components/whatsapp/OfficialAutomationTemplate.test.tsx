import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { projectTemplateSnapshot } from '../../../supabase/functions/_shared/whatsapp-template-access-core';
import { OfficialAutomationTemplate } from './OfficialAutomationTemplate';

const template = projectTemplateSnapshot({
  channel: null, binding: null, unitAdopted: false,
  templates: [], jobs: [], generatedAt: '2026-10-09T12:00:00Z'
}).templates[6];

it('shows fixed body/footer, unknown quality and pending status without an editor', () => {
  const sync = vi.fn();
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, effectiveCategory: null, quality: 'UNKNOWN', localStatus: 'pending', remoteStatus: 'PENDING' }} onSync={sync} />);
  expect(screen.getByText('Pendente de análise')).toBeInTheDocument();
  expect(screen.getByText('Qualidade desconhecida')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === template.body)).toBeInTheDocument();
  expect(screen.getByText(template.footer)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar sincronização' }));
  expect(sync).toHaveBeenCalledOnce();
});

it('does not equate approved remote status with current integrity or synchronization', () => {
  render(<OfficialAutomationTemplate template={{ ...template, version: 1, effectiveCategory: null, quality: 'UNKNOWN', remoteStatus: 'APPROVED', localStatus: 'usable', hashMatches: false, syncRequired: true }} onSync={vi.fn()} canSync={false} />);
  expect(screen.getByText(/Conteúdo ainda não conferido/)).toBeInTheDocument();
  expect(screen.getByText(/Sincronização necessária/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
