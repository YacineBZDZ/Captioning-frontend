import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INFO } from '../api/client';
import { initialRunState, runReducer, type RunState } from '../state/pipeline';
import { analyse, renderApp } from '../test/renderApp';
import { Timeline } from './Timeline';

function stepItem(title: string) {
  return screen.getByRole('heading', { name: title }).closest('li')!;
}

describe('Timeline, rescue scenario', () => {
  it('shows the reclassification and ends with a caption', async () => {
    const { user } = renderApp('rescued_photo');
    await analyse(user);

    const caption = await screen.findByText('a dog is running on the beach', {
      selector: '.result-caption',
    });
    expect(caption).toBeVisible();

    const titles = within(screen.getByRole('list', { name: 'Analysis steps' }))
      .getAllByRole('heading')
      .map((h) => h.textContent);
    expect(titles).toEqual([
      'Reading the image',
      'Is it a photograph?',
      'Checking noise and blur',
      'Cleaning the image',
      'Re-checking after cleaning',
      'Writing the caption',
    ]);

    const first = stepItem('Is it a photograph?');
    expect(first).toHaveAttribute('data-status', 'done');
    expect(first).toHaveTextContent('Painting – 62 % at first, recovered after cleaning');

    const recheck = stepItem('Re-checking after cleaning');
    expect(recheck).toHaveAttribute('data-status', 'done');
    expect(recheck).toHaveTextContent('Photo – 88 %');
    expect(within(recheck).getByText('MobileNetV2')).toBeInTheDocument();

    const denoise = stepItem('Cleaning the image');
    expect(within(denoise).getByRole('img', { name: 'Denoised preview, 192×192' })).toBeVisible();
    expect(within(denoise).getByRole('slider')).toBeInTheDocument();

    expect(stepItem('Writing the caption')).toHaveTextContent('on the denoised image');
    expect(stepItem('Checking noise and blur')).toHaveTextContent('Thresholds not calibrated yet.');
  });

  it('marks a provisional "not a photo" in amber while the run continues', () => {
    let s: RunState = runReducer(initialRunState, { type: 'start', at: 0 });
    s = runReducer(s, {
      type: 'event',
      event: {
        event: 'step',
        step: 'classification',
        status: 'done',
        elapsed_ms: 41,
        data: {
          predicted_class: 'Painting',
          confidence: 0.62,
          probabilities: { Painting: 0.62, Photo: 0.3, Schematics: 0.02, Sketch: 0.05, Text: 0.01 },
          is_photo: false,
          photo_threshold: 0.5,
          input: 'original',
        },
      },
    });
    render(<Timeline run={s} info={DEFAULT_INFO} />);
    const step = stepItem('Is it a photograph?');
    expect(step).toHaveAttribute('data-warn');
    expect(step).not.toHaveAttribute('data-status', 'error');
    expect(step).toHaveTextContent('Not a photo – checking whether noise is hiding it…');
    expect(step).toHaveTextContent('41 ms');
    // Steps the backend has not reached yet are still pending, not "not needed".
    expect(stepItem('Writing the caption')).toHaveAttribute('data-status', 'pending');
    // Reclassification is only shown once the backend emits it.
    expect(screen.queryByRole('heading', { name: 'Re-checking after cleaning' })).toBeNull();
  });

  it('clean photo: denoising skipped with a reason, and the caption is announced', async () => {
    const { user } = renderApp('clean_photo');
    await analyse(user);
    await screen.findByText('a brown bear is standing in the grass', {
      selector: '.result-caption',
    });
    expect(stepItem('Cleaning the image')).toHaveTextContent('Image is already clean');
    expect(stepItem('Reading the image')).toHaveTextContent(/JPEG, 2 KB/);
    const live = document.querySelector('[aria-live="polite"][aria-relevant="additions"]')!;
    expect(live).toHaveTextContent('Done. Caption: a brown bear is standing in the grass');
  });
});
