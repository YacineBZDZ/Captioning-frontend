import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockCaptionFor } from '../../mocks/mockBackend';
import { analyseMany, jpeg, renderApp } from '../../test/renderApp';

const MIXED = [
  'photo.jpg',
  'painting.jpg',
  'degraded-painting.jpg',
  'noisy-street.jpg',
  'rescue-beach.jpg',
  'bad-file.jpg',
];

function cards() {
  return within(screen.getByRole('list', { name: 'Images' })).getAllByRole('listitem');
}

function card(name: string) {
  return cards().find((c) => c.textContent?.includes(name))!;
}

async function finished() {
  await screen.findByText(/^\d+ captioned/, {}, { timeout: 4000 });
}

describe('Batch run view, mixed scenario', () => {
  it('shows statuses, badges and captions in upload order', async () => {
    const { user } = renderApp('batch_mixed');
    await analyseMany(
      user,
      MIXED.map((n) => jpeg(n)),
    );
    await finished();

    expect(screen.getByText('3 captioned, 2 not photos, 1 error')).toBeInTheDocument();
    expect(cards().map((c) => c.querySelector('.bcard-name')?.textContent)).toEqual(
      MIXED.map((n) => `Details for ${n}`),
    );

    const photo = card('photo.jpg');
    expect(within(photo).getByText('Done')).toBeInTheDocument();
    expect(within(photo).getByText('Photo 97 %')).toBeInTheDocument();
    expect(photo).toHaveTextContent(mockCaptionFor('photo.jpg'));
    expect(within(photo).queryByText('Denoised')).toBeNull();

    const noisy = card('noisy-street.jpg');
    expect(within(noisy).getByText('Denoised')).toBeInTheDocument();
    expect(noisy).toHaveTextContent(mockCaptionFor('noisy-street.jpg'));

    const rescued = card('rescue-beach.jpg');
    expect(within(rescued).getByText('Photo 88 %')).toBeInTheDocument();

    const painting = card('painting.jpg');
    expect(painting).toHaveAttribute('data-status', 'not_a_photo');
    expect(within(painting).getByText('Not a photo')).toBeInTheDocument();
    expect(within(painting).getByText('Painting 93 %')).toBeInTheDocument();
    expect(painting).toHaveTextContent('It looks like a painting, 93 % sure.');
    expect(painting).not.toHaveTextContent(mockCaptionFor('painting.jpg'));
    expect(within(painting).queryByRole('button', { name: /^Copy/ })).toBeNull();

    const degraded = card('degraded-painting.jpg');
    expect(degraded).toHaveTextContent('Checked again after cleaning.');
    expect(degraded).not.toHaveTextContent(mockCaptionFor('degraded-painting.jpg'));

    const bad = card('bad-file.jpg');
    expect(bad).toHaveAttribute('data-status', 'error');
    expect(within(bad).getByText('Error')).toBeInTheDocument();
    expect(bad).toHaveTextContent('The image could not be read.');

    // Strip: every accepted image went through classification.
    const strip = screen.getByRole('list', { name: 'Stages' });
    expect(within(strip).getByText('Upload').nextSibling).toHaveTextContent('5 / 6');
    expect(within(strip).getByText('Captioning').nextSibling).toHaveTextContent('3 / 6');
  });

  it('filters by outcome with counts, keeping the original order', async () => {
    const { user } = renderApp('batch_mixed');
    await analyseMany(
      user,
      MIXED.map((n) => jpeg(n)),
    );
    await finished();
    const chips = screen.getByRole('group', { name: 'Show' });
    const chip = (name: RegExp) => within(chips).getByRole('button', { name });
    expect(chip(/^All 6/)).toHaveAttribute('aria-pressed', 'true');

    await user.click(chip(/^Captioned 3/));
    expect(chip(/^Captioned 3/)).toHaveAttribute('aria-pressed', 'true');
    expect(cards().map((c) => c.querySelector('.bcard-name')?.textContent)).toEqual([
      'Details for photo.jpg',
      'Details for noisy-street.jpg',
      'Details for rescue-beach.jpg',
    ]);
    await user.click(chip(/^Not a photo 2/));
    expect(cards()).toHaveLength(2);
    await user.click(chip(/^Errors 1/));
    expect(cards()).toHaveLength(1);
    await user.click(chip(/^All 6/));
    expect(cards()).toHaveLength(6);
  });

  it('announces the end politely', async () => {
    const { user } = renderApp('batch_mixed');
    await analyseMany(
      user,
      MIXED.map((n) => jpeg(n)),
    );
    const live = document.querySelector('[aria-live="polite"][aria-relevant="additions"]')!;
    await waitFor(
      () => expect(live).toHaveTextContent('All done: 3 captioned, 2 not photos, 1 error'),
      { timeout: 5000 },
    );
  });
});

describe('Detail dialog', () => {
  it('traps focus, closes on Escape and returns focus to the card', async () => {
    const { user } = renderApp('batch_mixed');
    await analyseMany(user, [jpeg('photo.jpg'), jpeg('painting.jpg')]);
    await finished();

    const opener = within(card('photo.jpg')).getByRole('button', { name: /Details for photo.jpg/ });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'photo.jpg' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const copy = within(dialog).getByRole('button', { name: 'Copy' });
    expect(close).toHaveFocus();

    // Same details as the single-image timeline.
    expect(within(dialog).getByRole('list', { name: 'Analysis steps' })).toBeInTheDocument();
    expect(within(dialog).getByText('Thresholds not calibrated yet.')).toBeInTheDocument();
    expect(within(dialog).getByText(mockCaptionFor('photo.jpg'))).toBeInTheDocument();

    await user.tab();
    expect(copy).toHaveFocus();
    await user.tab(); // wraps around
    expect(close).toHaveFocus();
    await user.tab({ shift: true }); // and backwards
    expect(copy).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('shows the before/after slider for a denoised image, and no caption for a painting', async () => {
    const { user } = renderApp('batch_mixed');
    await analyseMany(user, [jpeg('noisy-street.jpg'), jpeg('painting.jpg')]);
    await finished();
    await user.click(within(card('noisy-street.jpg')).getByRole('button', { name: /Details/ }));
    let dialog = screen.getByRole('dialog', { name: 'noisy-street.jpg' });
    expect(
      within(dialog).getByRole('img', { name: 'Denoised preview, 192×192' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('slider')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    await user.click(within(card('painting.jpg')).getByRole('button', { name: /Details/ }));
    dialog = screen.getByRole('dialog', { name: 'painting.jpg' });
    expect(dialog).toHaveTextContent('It looks like a painting, 93 % sure.');
    expect(within(dialog).queryByText('Caption')).toBeNull();
    expect(within(dialog).getByRole('list', { name: /Class probabilities/ })).toBeInTheDocument();
  });
});

describe('Retry and batch-level errors', () => {
  it('"Retry failed" re-sends only the retryable files', async () => {
    const { user, batchRequests } = renderApp('batch_item_timeout');
    const names = ['photo-1.jpg', 'painting.jpg', 'bad.jpg', 'photo-2.jpg', 'photo-3.jpg'];
    await analyseMany(
      user,
      names.map((n) => jpeg(n)),
    );
    await finished();
    expect(card('photo-3.jpg')).toHaveTextContent(
      'The server ran out of time for this image. Retry it.',
    );
    expect(batchRequests).toEqual([names]);

    await user.click(screen.getByRole('button', { name: 'Retry failed (1)' }));
    await waitFor(() => expect(card('photo-3.jpg')).toHaveAttribute('data-status', 'done'));
    expect(batchRequests).toEqual([names, ['photo-3.jpg']]);
    expect(card('photo-3.jpg')).toHaveTextContent(mockCaptionFor('photo-3.jpg'));
    // Earlier results are kept.
    expect(card('photo-1.jpg')).toHaveTextContent(mockCaptionFor('photo-1.jpg'));
    expect(card('painting.jpg')).toHaveAttribute('data-status', 'not_a_photo');
    expect(screen.queryByRole('button', { name: /Retry failed/ })).toBeNull();
  });

  it('SERVER_BUSY shows a batch alert with a "Retry in N s" countdown', async () => {
    const { user } = renderApp('batch_busy');
    await analyseMany(user, [jpeg('a.jpg'), jpeg('b.jpg'), jpeg('c.jpg')]);
    const alert = await screen.findByRole('alert', { name: 'The server is busy' });
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent('You can retry in 10 s.');
    expect(within(alert).getByRole('button', { name: /Retry in \d+ s/ })).toBeDisabled();
    expect(cards().every((c) => c.getAttribute('data-status') === 'interrupted')).toBe(true);
    expect(cards().every((c) => !c.textContent?.includes('caption'))).toBe(true);
  });

  it('TOO_MANY_FILES offers "Retry with smaller groups", which re-reads the limits', async () => {
    const { user, batchRequests } = renderApp('batch_too_many');
    const files = Array.from({ length: 8 }, (_, i) => jpeg(`photo-${i + 1}.jpg`));
    await analyseMany(user, files);
    const alert = await screen.findByRole('alert', { name: 'Too many images in one request' });
    await user.click(within(alert).getByRole('button', { name: 'Retry with smaller groups' }));
    await screen.findByText('8 captioned', {}, { timeout: 4000 });
    expect(batchRequests.map((r) => r.length)).toEqual([8, 5, 3]);
    expect(batchRequests.slice(1).flat()).toEqual(files.map((f) => f.name));
  });
});
