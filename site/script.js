// 导航滚动状态、移动端菜单与滚动入场动画；无依赖。
(() => {
  // 先标记 JS 可用，CSS 才把 .reveal 设为待入场状态；无脚本时内容直接可见。
  document.documentElement.classList.add('js');
  // 截图/打印用：?static=1 直接展示全部内容，不依赖滚动触发。
  if (new URLSearchParams(window.location.search).has('static')) {
    document.documentElement.classList.add('no-anim');
  }
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('navToggle');
  const year = document.getElementById('year');

  if (year) year.textContent = String(new Date().getFullYear());

  const onScroll = () => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('.nav-links a, .nav-actions a').forEach((link) => {
      link.addEventListener('click', () => {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px' },
  );
  items.forEach((el) => observer.observe(el));

  // 滚动时高亮当前栏目；用窄观察带避免相邻 section 同时命中。
  const navLinks = [...document.querySelectorAll('.nav-links a')];
  const linkById = new Map(
    navLinks.map((link) => [link.getAttribute('href').slice(1), link]),
  );
  const sections = [...document.querySelectorAll('main section[id]')].filter((s) =>
    linkById.has(s.id),
  );
  if (sections.length > 0 && 'IntersectionObserver' in window) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) => link.classList.remove('active'));
          linkById.get(entry.target.id)?.classList.add('active');
        });
      },
      { rootMargin: '-42% 0px -52% 0px', threshold: 0 },
    );
    sections.forEach((section) => spy.observe(section));
  }
})();
