'use strict';

const $ = id => document.getElementById(id);

function setFilled(input) {
  input.closest('.field')?.classList.toggle('filled', input.value.trim() !== '');
}
document.querySelectorAll('input, select').forEach(input => {
  input.addEventListener('input', () => setFilled(input));
  input.addEventListener('change', () => setFilled(input));
});

function showValid(id) {
  $('f-' + id).classList.remove('has-error');
  $('f-' + id).classList.add('is-valid');
  $('e-' + id).textContent = '';
}

function showError(id, message) {
  $('f-' + id).classList.remove('is-valid');
  $('f-' + id).classList.add('has-error');
  $('e-' + id).textContent = message;
}

function showNeutral(id) {
  $('f-' + id).classList.remove('has-error', 'is-valid');
  $('e-' + id).textContent = '';
}
