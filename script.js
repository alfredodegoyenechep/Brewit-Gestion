const navLinks = document.querySelectorAll('.nav-link');

navLinks.forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    navLinks.forEach((item) => item.classList.toggle('active', item === link));
  });
});

const orderButton = document.querySelector('.topbar-actions .primary');
if (orderButton) {
  orderButton.addEventListener('click', () => {
    orderButton.textContent = 'Order Drafted';
    orderButton.disabled = true;
  });
}

const refresh = document.querySelector('.activity-panel .icon-button');
if (refresh) {
  refresh.addEventListener('click', () => {
    refresh.textContent = 'Synced';
    refresh.classList.add('synced');
  });
}
