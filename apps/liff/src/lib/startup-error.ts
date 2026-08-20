export function startupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
