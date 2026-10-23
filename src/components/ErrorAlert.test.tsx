import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { analyse, renderApp } from '../test/renderApp';

describe('NOT_A_PHOTO alert', () => {
  it('explains the class and confidence, shows the bars, moves focus, and never shows a caption', async () => {
    const { user } = renderApp('clean_painting');
    await analyse(user);

    const alert = await screen.findByRole('alert', { name: "This doesn't look like a photograph" });
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent('It looks like a painting, 93 % sure.');
    expect(alert).not.toHaveTextContent('We also tried cleaning the image');

    const bars = within(alert).getByRole('list', { name: 'Class probabilities' });
    const rows = within(bars).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent?.replace(/\s*\d+ %$/, ''))).toEqual([
      'Painting (predicted)',
      'Photo',
      'Schematics',
      'Sketch',
      'Text',
    ]);
    expect(rows[0]).toHaveAttribute('data-predicted');
    expect(rows[0]).toHaveTextContent('93 %');

    expect(within(alert).getByRole('button', { name: 'Choose another image' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Caption' })).not.toBeInTheDocument();

    // The failing step is highlighted in the timeline.
    const step = screen.getByRole('heading', { name: 'Is it a photograph?' }).closest('li');
    expect(step).toHaveAttribute('data-status', 'error');
    expect(within(step!).getByText('Failed here')).toBeInTheDocument();
  });

  it('says the image was rechecked after cleaning', async () => {
    const { user } = renderApp('degraded_painting');
    await analyse(user);
    const alert = await screen.findByRole('alert', { name: "This doesn't look like a photograph" });
    expect(alert).toHaveTextContent('It looks like a painting, 90 % sure.');
    expect(alert).toHaveTextContent('We also tried cleaning the image and checked again.');
    const recheck = screen
      .getByRole('heading', { name: 'Re-checking after cleaning' })
      .closest('li');
    expect(recheck).toHaveAttribute('data-status', 'error');
  });

  it('"Choose another image" clears the selection and focuses the file input', async () => {
    const { user } = renderApp('clean_painting');
    await analyse(user);
    const alert = await screen.findByRole('alert', { name: "This doesn't look like a photograph" });
    await user.click(within(alert).getByRole('button', { name: 'Choose another image' }));
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeDisabled();
    expect(screen.getByText('Choose an image first.')).toBeInTheDocument();
    await vi.waitFor(() => expect(document.querySelector('input[type="file"]')).toHaveFocus());
  });
});

describe('other errors', () => {
  it('SERVER_BUSY disables Retry for the Retry-After delay', async () => {
    const { user } = renderApp('server_busy');
    await analyse(user);
    const alert = await screen.findByRole('alert', { name: 'The server is busy' });
    expect(within(alert).getByRole('button', { name: /Retry in \d+ s/ })).toBeDisabled();
  });

  it('INTERNAL_ERROR shows the request id to quote', async () => {
    const { user } = renderApp('internal_error');
    await analyse(user);
    const alert = await screen.findByRole('alert', { name: 'Something went wrong on the server' });
    expect(alert).toHaveTextContent(/Request ID: [0-9a-f]{8}/);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('FILE_TOO_LARGE mentions the limit', async () => {
    const { user } = renderApp('file_too_large');
    await analyse(user);
    const alert = await screen.findByRole('alert', { name: 'The file is too large' });
    expect(alert).toHaveTextContent('up to 10 MB');
  });

  it('CONNECTION_LOST when the stream closes without a terminal event', async () => {
    const { user } = renderApp('connection_lost');
    await analyse(user);
    await screen.findByRole('alert', { name: 'The connection was lost' });
    const step = screen.getByRole('heading', { name: 'Checking noise and blur' }).closest('li');
    expect(step).toHaveAttribute('data-status', 'error');
  });
});
