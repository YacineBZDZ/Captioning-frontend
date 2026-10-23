import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { createApiClient } from '../api/client';
import { createMockBackend, type ScenarioId } from '../mocks/mockBackend';

export function jpeg(name = 'photo.jpg', size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}

/** Renders the whole app against the mock backend with no artificial delays. */
export function renderApp(scenario: ScenarioId = 'clean_photo') {
  const backend = createMockBackend({ scenario, delay: () => 0 });
  const api = createApiClient('http://mock.local', backend.fetch);
  const user = userEvent.setup({ applyAccept: false });
  const utils = render(<App api={api} />);
  return { ...utils, backend, user };
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
