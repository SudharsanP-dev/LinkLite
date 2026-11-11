(() => {
  const message = 'This static preview needs the LinkLite server and database for account features.';
  const authError = document.querySelector('#auth-error');

  document.querySelector('#auth-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (authError) authError.textContent = message;
  });

  document.querySelector('#guest-button')?.addEventListener('click', () => {
    if (authError) authError.textContent = message;
  });
})();
