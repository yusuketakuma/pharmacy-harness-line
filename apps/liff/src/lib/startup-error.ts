export const STARTUP_ERROR_MESSAGE =
  'LINEのトーク画面からもう一度開いてください。それでも開けない場合は、薬局へお問い合わせください。';

/** Patients see only a fixed message; the raw error goes to the console for staff. */
export function startupErrorMessage(error: unknown): string {
  console.error('liff startup failed', error);
  return STARTUP_ERROR_MESSAGE;
}

export function renderStartupError(root: HTMLElement, error: unknown): void {
  const container = document.createElement('div');
  container.style.cssText = 'padding: 2rem; font-family: sans-serif; color: #b91c1c;';

  const heading = document.createElement('h1');
  heading.style.cssText = 'font-size: 1.25rem; margin-bottom: 1rem;';
  heading.textContent = '起動できませんでした';

  const message = document.createElement('p');
  message.textContent = startupErrorMessage(error);
  container.append(heading, message);
  root.replaceChildren(container);
}
