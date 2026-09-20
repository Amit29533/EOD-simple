/**
 * Motion utilities — staggered entrance animations, counter tweens,
 * and view-transition helpers. Respects prefers-reduced-motion.
 */

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Animate child elements with a staggered fade-up entrance.
 * Uses IntersectionObserver so elements only animate when visible.
 * @param {HTMLElement} root - Container whose children should animate
 * @param {string} selector - CSS selector for animatable children
 * @param {object} opts - { delay, stagger, threshold }
 */
export function staggerIn(root, selector = '.card, .stat, .q-card, .activity-item, .status-row, table.data tbody tr', opts = {}) {
  if (reduceMotion()) return;
  const { stagger = 60, threshold = 0.08, maxDelay = 600 } = opts;
  const items = root.querySelectorAll(selector);
  if (!items.length) return;

  items.forEach((el, i) => {
    // Cap the stagger delay so large lists don't have invisible items for too long
    const delay = Math.min(i * stagger, maxDelay);
    el.style.setProperty('--stagger', `${delay}ms`);
    el.classList.remove('animate-in', 'is-visible'); // Clean up from previous renders
    el.classList.add('animate-in');
  });

  // Use IntersectionObserver so elements animate on scroll-into-view too
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold, rootMargin: '40px 0px -20px 0px' }); // Top margin catches elements already in view

    items.forEach((el) => observer.observe(el));
    
    // Fallback: if IntersectionObserver doesn't trigger within 2 seconds, make all visible
    setTimeout(() => {
      items.forEach((el) => {
        if (!el.classList.contains('is-visible')) {
          el.classList.add('is-visible');
        }
      });
    }, 2000);
  } else {
    // Fallback: just make them all visible
    items.forEach((el) => el.classList.add('is-visible'));
  }
}

/**
 * Animate a number counting up inside an element.
 * @param {HTMLElement} el
 * @param {number} to
 * @param {object} opts - { duration, suffix, prefix }
 */
export function countUp(el, to, { duration = 1200, suffix = '', prefix = '' } = {}) {
  if (!el || to == null || Number.isNaN(Number(to))) return;
  if (reduceMotion()) { el.textContent = `${prefix}${to}${suffix}`; return; }
  let start = null;
  const target = Number(to);
  const tick = (now) => {
    if (start === null) start = now;
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 4); // ease-out quart
    el.textContent = `${prefix}${Math.round(target * eased)}${suffix}`;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Animate the view container when it changes content.
 * Adds a quick fade-in that the CSS handles.
 *
 * The class MUST be removed once the animation ends: `viewFadeIn` is filled
 * `both`, so a lingering `.view-enter` would keep a (identity) transform on
 * the container forever. Any transform turns the container into the
 * containing block for `position: fixed` descendants — the sign-in overlay
 * (.auth-stage) is fixed and rendered inside #view, so a stale class
 * collapsed the login screen into a ~106px strip after sign-out (it only
 * looked right again after a full page reload).
 */
export function animateView(view) {
  if (reduceMotion()) return;
  if (typeof view._endViewEnter === 'function') view._endViewEnter();
  view.classList.remove('view-enter');
  // Force reflow so the class re-triggers
  void view.offsetWidth;
  view.classList.add('view-enter');
  const end = () => {
    view.removeEventListener('animationend', onEnd);
    clearTimeout(timer);
    if (view._endViewEnter === end) view._endViewEnter = null;
    view.classList.remove('view-enter');
  };
  const onEnd = (e) => {
    // Ignore animationend bubbling from children (stagger/card animations).
    if (e.target === view && e.animationName === 'viewFadeIn') end();
  };
  const timer = setTimeout(end, 700); // fallback: animation is .42s; covers quiet tabs
  view.addEventListener('animationend', onEnd);
  view._endViewEnter = end;
}

/**
 * Add a subtle "ripple" effect to a button on click.
 * @param {HTMLElement} btn
 */
export function ripple(btn) {
  if (reduceMotion()) return;
  // Prevent duplicate listeners
  if (btn.dataset.rippleInit) return;
  btn.dataset.rippleInit = '1';
  
  btn.addEventListener('pointerdown', (e) => {
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = Math.max(rect.width, rect.height) * 2;
    const circle = document.createElement('span');
    circle.className = 'btn-ripple';
    circle.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;`;
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 600);
  });
}

/**
 * Initialize ripple on all buttons in a container.
 */
export function initRipples(root = document) {
  if (reduceMotion()) return;
  root.querySelectorAll('.btn').forEach(ripple);
}


