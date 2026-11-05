import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { batchReady, fileInput, jpeg, renderApp } from '../test/renderApp';

describe('Selection grid', () => {
  it('lists refused files with their reason and keeps the others', async () => {
    const { user } = renderApp('batch_mixed');
    await batchReady();
    await user.upload(fileInput(), [
      jpeg('a.jpg'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      jpeg('b.jpg'),
      jpeg('huge.jpg', 11 * 1024 * 1024),
      jpeg('c.jpg'),
    ]);
    const refused = screen.getByRole('list', { name: 'Files not added' });
    expect(
      within(refused)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '“notes.txt” is not a supported image type. Use JPEG, PNG, WEBP, BMP.',
      '“huge.jpg” is 11.0 MB; the limit is 10 MB.',
    ]);
    const thumbs = screen.getByRole('list', { name: 'Selected images' });
    expect(within(thumbs).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('3 images')).toBeInTheDocument();
    expect(screen.getByText('6 KB')).toBeInTheDocument();
    expect(screen.getByText('1 group')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyse 3 images' })).toBeEnabled();
  });

  it('removes one image, adds more on a second drop, and clears all', async () => {
    const { user } = renderApp('batch_mixed');
    await batchReady();
    await user.upload(fileInput(), [jpeg('a.jpg'), jpeg('b.jpg'), jpeg('c.jpg')]);
    await user.click(screen.getByRole('button', { name: 'Remove b.jpg' }));
    const thumbs = screen.getByRole('list', { name: 'Selected images' });
    expect(
      within(thumbs)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a.jpg', 'c.jpg']);
    expect(screen.getByText('2 images')).toBeInTheDocument();

    await user.upload(fileInput(), [jpeg('d.jpg'), jpeg('e.jpg')]);
    expect(screen.getByText('4 images')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyse 4 images' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('list', { name: 'Selected images' })).toBeNull();
    expect(screen.getByText('Choose an image first.')).toBeInTheDocument();
  });

  it('counts the groups the selection will be split into', async () => {
    const { user } = renderApp('batch_45');
    await batchReady();
    await user.upload(
      fileInput(),
      Array.from({ length: 45 }, (_, i) => jpeg(`p${i}.jpg`, 1024)),
    );
    expect(screen.getByText('45 images')).toBeInTheDocument();
    expect(screen.getByText('3 groups')).toBeInTheDocument();
    expect(screen.getByText(/Sent in 3 groups, one after another/)).toBeInTheDocument();
  });

  it('refuses images beyond 200 with a clear message', async () => {
    const { user } = renderApp('batch_45');
    await batchReady();
    await user.upload(
      fileInput(),
      Array.from({ length: 205 }, (_, i) => jpeg(`p${i}.jpg`, 10)),
    );
    expect(screen.getByText('200 images')).toBeInTheDocument();
    expect(
      screen.getByText('5 images were not added: at most 200 images can be analysed at once.'),
    ).toBeInTheDocument();
  });

  it('an old backend accepts one image at a time, with a note', async () => {
    const { user } = renderApp('old_backend');
    await screen.findByText('This server handles one image at a time.');
    expect(fileInput()).not.toHaveAttribute('multiple');
    await user.upload(fileInput(), jpeg('a.jpg'));
    // A second pick replaces the first: no batch on this server.
    await user.upload(fileInput(), jpeg('b.jpg'));
    expect(screen.getByRole('img', { name: 'Preview of b.jpg' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Selected images' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeEnabled();
  });
});
