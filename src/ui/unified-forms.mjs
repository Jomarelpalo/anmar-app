const CONTROL_SELECTOR = 'input:not([type="hidden"]), select, textarea';

const COMPACT_IDS = new Set([
  'loginForm', 'setPassForm', 'comm-compose', 'comm-invite-form',
]);

function readableName(control) {
  const explicit = control.getAttribute('aria-label');
  if (explicit) return explicit;
  const labelled = control.labels?.[0]?.textContent;
  if (labelled?.trim()) return labelled.trim();
  const wrapping = control.closest('label')?.childNodes?.[0]?.textContent;
  if (wrapping?.trim()) return wrapping.trim();
  return control.placeholder || control.name || control.id || 'Campo del formulario';
}

function classify(form, controls) {
  const declared = form.dataset.anmarFormKind;
  if (['compact', 'standard', 'complex'].includes(declared)) return declared;
  if (COMPACT_IDS.has(form.id) || form.classList.contains('comm-compose')) return 'compact';
  if (controls.length >= 7 || form.id === 'cmp-create') return 'complex';
  if (controls.length <= 2) return 'compact';
  return 'standard';
}

function enhanceControl(control) {
  if (control.dataset.anmarControlEnhanced === 'true') return;
  control.dataset.anmarControlEnhanced = 'true';
  control.classList.add('anmar-form-control');
  if (!control.hasAttribute('aria-label') && !control.closest('label') && !control.labels?.length) {
    control.setAttribute('aria-label', readableName(control));
  }
  control.addEventListener('invalid', () => control.setAttribute('aria-invalid', 'true'));
  control.addEventListener('input', () => {
    if (control.validity?.valid) control.removeAttribute('aria-invalid');
  });
}

export function enhanceForm(form) {
  if (!(form instanceof HTMLFormElement) || form.dataset.anmarFormEnhanced === 'true') return form;
  const controls = [...form.querySelectorAll(CONTROL_SELECTOR)];
  const kind = classify(form, controls);
  form.classList.add('anmar-form', `anmar-form--${kind}`);
  form.dataset.anmarFormEnhanced = 'true';
  form.dataset.anmarFormKind = kind;
  controls.forEach(enhanceControl);
  form.querySelectorAll('label').forEach((label) => label.classList.add('anmar-form-label'));
  form.querySelectorAll('button[type="submit"], .btn-primary').forEach((button) => {
    button.classList.add('anmar-form-primary-action');
  });
  form.querySelectorAll('[role="status"], .form-msg, [id$="-msg"]').forEach((status) => {
    status.classList.add('anmar-form-status');
    status.setAttribute('aria-live', status.getAttribute('aria-live') || 'polite');
  });
  return form;
}

export function mountUnifiedForms(root = document) {
  root.querySelectorAll('form').forEach(enhanceForm);
  root.querySelectorAll(CONTROL_SELECTOR).forEach(enhanceControl);
  if (root === document && !window.__anmarUnifiedFormsObserver) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches('form')) enhanceForm(node);
        if (node.matches(CONTROL_SELECTOR)) enhanceControl(node);
        node.querySelectorAll?.('form').forEach(enhanceForm);
        node.querySelectorAll?.(CONTROL_SELECTOR).forEach(enhanceControl);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__anmarUnifiedFormsObserver = observer;
  }
  document.documentElement.dataset.anmarUnifiedForms = 'ready';
  return { forms: root.querySelectorAll('form').length };
}
