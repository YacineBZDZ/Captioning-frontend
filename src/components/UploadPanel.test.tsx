import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fileInput, jpeg, renderApp } from '../test/renderApp';

describe('Upload validation', () => {
  it('refuses an unsupported type with a clear message', async () => {
    const { user } = renderApp();
    await screen.findByText('Online');
    await user.upload(fileInput(), new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(
      screen.getByText('“notes.txt” is not a supported image type. Use JPEG, PNG, WEBP, BMP.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeDisabled();
  });

  it('refuses a file over the size limit', async () => {
    const { user } = renderApp();
    await screen.findByText('Online');
    const big = jpeg('huge.jpg', 11 * 1024 * 1024);
    await user.upload(fileInput(), big);
    expect(screen.getByText('“huge.jpg” is 11.0 MB; the limit is 10 MB.')).toBeInTheDocument();
  });

  it('accepts a valid image, shows a preview and enables Analyse', async () => {
    const { user } = renderApp();
    await screen.findByText('Online');
    await user.upload(fileInput(), jpeg('cat.jpg', 183422));
    expect(screen.getByRole('img', { name: 'Preview of cat.jpg' })).toBeInTheDocument();
    expect(screen.getByText('179 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeEnabled();
  });

  it('keeps Analyse disabled with a visible reason while the server is offline', async () => {
    const { user } = renderApp('server_offline');
    await screen.findByText('Offline');
    expect(screen.getByText(/Free servers sleep after a period of inactivity/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Wake up server' })).toBeVisible();
    await user.upload(fileInput(), jpeg());
    const button = screen.getByRole('button', { name: 'Analyse' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/offline or asleep/);
  });
});
