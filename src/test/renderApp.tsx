import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createApiClient, type FetchFn } from '../api/client';
import { createMockBackend, type ScenarioId } from '../mocks/mockBackend';

export function jpeg(name = 'photo.jpg', size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

/**
 * Renders the whole app against the mock backend with no artificial delays.
 * `batchRequests` records the file names sent in each POST /v1/batch.
 */
export function renderApp(scenario: ScenarioId = 'clean_photo') {
  const backend = createMockBackend({ scenario, delay: () => 0 });
  const batchRequests: string[][] = [];
  const fetchFn: FetchFn = (input, init) => {
    if (input.includes('/v1/batch') && init?.body instanceof FormData)
      batchRequests.push(init.body.getAll('files').map((f) => (f as File).name));
    return backend.fetch(input, init);
  };
  const api = createApiClient('http://mock.local', fetchFn);
  const user = userEvent.setup({ applyAccept: false });
  const utils = render(<App api={api} />);
  return { ...utils, backend, user, batchRequests };
}

export function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

/** Waits for "online", picks an image and presses Analyse. */
export async function analyse(user: ReturnType<typeof userEvent.setup>, file = jpeg()) {
  await screen.findByText('Online');
  await user.upload(fileInput(), file);
  const button = screen.getByRole('button', { name: 'Analyse' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** Waits until the server is online and its batch limits are known. */
export async function batchReady() {
  await screen.findByText('Online');
  await waitFor(() => expect(fileInput()).toHaveAttribute('multiple'));
  await screen.findByText(/up to 200 images/);
}

/** Picks several images and presses "Analyse N images". */
export async function analyseMany(user: ReturnType<typeof userEvent.setup>, files: File[]) {
  await batchReady();
  await user.upload(fileInput(), files);
  const button = screen.getByRole('button', { name: `Analyse ${files.length} images` });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}
