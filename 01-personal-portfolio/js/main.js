/* =====================================================================
   Biraj Jeebun — Portfolio
   Vanilla JS. No dependencies, no build step, no storage APIs.

   EDIT YOUR CONTENT HERE:
     • PROJECTS     — the six project cards
     • SKILL_GROUPS — the skill chip groups
     • TIMELINE     — experience & education entries
   Everything below the "ENGINE" banner is behaviour and rarely needs
   changing.
   ===================================================================== */
(function () {
  'use strict';

  /* =================================================================
     CONTENT
     ================================================================= */

  /**
   * Project cards.
   * @typedef  {Object} Project
   * @property {string}   title    Card heading.
   * @property {string}   badge    Small label on the cover (e.g. "Web app").
   * @property {string}   year     Shown top-right of the cover.
   * @property {string}   description
   * @property {string[]} tech     Tech chips.
   * @property {{label: string, href: string, type?: 'demo'|'code'}[]} links
   * @property {[string, string]} [colors] Optional cover gradient override.
   */
  var PROJECTS = [
    {
      title: 'Orbit Dashboard',
      badge: 'Web app',
      year: '2025',
      description:
        'A real-time analytics dashboard with streaming charts, saved views and ' +
        'keyboard-first navigation. Sample project — replace with your own.',
      tech: ['TypeScript', 'React', 'WebSockets', 'D3', 'PostgreSQL'],
      links: [
        { label: 'Live demo', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#4f46e5', '#7c3aed']
    },
    {
      title: 'Ledger CLI',
      badge: 'Developer tool',
      year: '2025',
      description:
        'A zero-config command line tool for tracking personal finances in plain ' +
        'text files, with fuzzy search and CSV import. Sample project.',
      tech: ['Go', 'Cobra', 'SQLite', 'Bubble Tea'],
      links: [
        { label: 'Documentation', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#0ea5e9', '#2563eb']
    },
    {
      title: 'Pixel Forge',
      badge: 'Creative',
      year: '2024',
      description:
        'A browser-based sprite editor with layers, onion skinning and GIF export ' +
        '— all client side, nothing ever leaves the tab. Sample project.',
      tech: ['JavaScript', 'Canvas API', 'Web Workers', 'IndexedDB'],
      links: [
        { label: 'Try it', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#db2777', '#f97316']
    },
    {
      title: 'Trailhead API',
      badge: 'Backend',
      year: '2024',
      description:
        'A REST + GraphQL service for hiking route data, with tile caching, rate ' +
        'limiting and OpenAPI docs generated from types. Sample project.',
      tech: ['Node.js', 'Fastify', 'GraphQL', 'Redis', 'Docker'],
      links: [
        { label: 'API docs', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#059669', '#0d9488']
    },
    {
      title: 'Nocturne UI',
      badge: 'Open source',
      year: '2023',
      description:
        'An accessible component library built on native HTML semantics, shipped ' +
        'as plain ES modules with zero runtime dependencies. Sample project.',
      tech: ['CSS', 'Web Components', 'ARIA', 'Rollup'],
      links: [
        { label: 'Storybook', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#7c3aed', '#4338ca']
    },
    {
      title: 'Signal Sorter',
      badge: 'Machine learning',
      year: '2023',
      description:
        'A small pipeline that classifies noisy sensor streams and explains each ' +
        'prediction with feature attributions. Sample project.',
      tech: ['Python', 'scikit-learn', 'FastAPI', 'Pandas'],
      links: [
        { label: 'Write-up', href: '#', type: 'demo' },
        { label: 'Source', href: '#', type: 'code' }
      ],
      colors: ['#ea580c', '#dc2626']
    }
  ];

  /** Skill groups — `icon` is one of the keys in ICONS below. */
  var SKILL_GROUPS = [
    {
      name: 'Languages',
      icon: 'code',
      items: ['JavaScript', 'TypeScript', 'Python', 'Go', 'SQL', 'HTML', 'CSS']
    },
    {
      name: 'Frontend',
      icon: 'layout',
      items: ['React', 'Vue', 'Vite', 'Web Components', 'Accessibility (WCAG)', 'Responsive design']
    },
    {
      name: 'Backend & data',
      icon: 'server',
      items: ['Node.js', 'Fastify', 'REST', 'GraphQL', 'PostgreSQL', 'Redis']
    },
    {
      name: 'Tooling & practice',
      icon: 'tool',
      items: ['Git', 'Docker', 'CI/CD', 'Testing', 'Linux', 'Code review']
    }
  ];

  /** Experience & education. `kind` renders as the small uppercase label. */
  var TIMELINE = [
    {
      period: '2024 — Present',
      kind: 'Work',
      role: 'Replace with your job title',
      org: 'Replace with employer name',
      description:
        'Replace with your own experience. One or two sentences on scope, ' +
        'team size and the kind of problems you owned.',
      points: [
        'Replace with an achievement, ideally with a number attached.',
        'Replace with a technical decision you made and why.'
      ],
      tags: ['TypeScript', 'React', 'Node.js']
    },
    {
      period: '2022 — 2024',
      kind: 'Work',
      role: 'Replace with your job title',
      org: 'Replace with employer name',
      description:
        'Replace with your own experience. Placeholder text so the layout is ' +
        'complete — no real claims are made here.',
      points: [
        'Replace with something you shipped end to end.',
        'Replace with a collaboration or mentoring highlight.'
      ],
      tags: ['Python', 'PostgreSQL', 'Docker']
    },
    {
      period: '2021 — 2022',
      kind: 'Freelance',
      role: 'Replace with your role',
      org: 'Independent / contract',
      description:
        'Replace with your own experience. Describe the sort of clients you ' +
        'worked with and what you delivered.',
      points: [
        'Replace with a project type you delivered repeatedly.',
        'Replace with a result a client cared about.'
      ],
      tags: ['JavaScript', 'CSS', 'Static sites']
    },
    {
      period: '2017 — 2021',
      kind: 'Education',
      role: 'Replace with your degree or programme',
      org: 'Replace with institution name',
      description:
        'Replace with your own education details — course focus, thesis topic ' +
        'or notable coursework.',
      points: [
        'Replace with a relevant module, award or society.',
        'Replace with a capstone or research project.'
      ],
      tags: ['Algorithms', 'Databases', 'Distributed systems']
    }
  ];

  /* =================================================================
     ENGINE — behaviour below. Usually no need to edit.
     ================================================================= */

  var ICONS = {
    code:   '<path d="M8.5 17 3.5 12l5-5"/><path d="m15.5 7 5 5-5 5"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M9 9.5V20"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    tool:   '<path d="M14.5 6a3.7 3.7 0 0 0 4.9 4.9L21 12.5 12.5 21 4 12.5 12.5 4Z"/>',
    demo:   '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1.8 1.8 0 0 1-1.8 1.8H5A1.8 1.8 0 0 1 3.2 19V7.8A1.8 1.8 0 0 1 5 6h5"/>',
    code2:  '<path d="M8.5 17 3.5 12l5-5"/><path d="m15.5 7 5 5-5 5"/>'
  };

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /** Escape user-editable strings before inserting them as HTML. */
  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function svgIcon(name, extraClass) {
    return '<svg class="icon ' + (extraClass || '') + '" viewBox="0 0 24 24" ' +
           'aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
  }

  /** "Orbit Dashboard" -> "OD" */
  function initials(title) {
    return String(title)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); })
      .join('');
  }

  var prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  /* -----------------------------------------------------------------
     Rendering
     ----------------------------------------------------------------- */
  function renderSkills() {
    var grid = $('#skills-grid');
    if (!grid) return;

    grid.innerHTML = SKILL_GROUPS.map(function (group, i) {
      var chips = (group.items || []).map(function (item) {
        return '<li><span class="chip">' + esc(item) + '</span></li>';
      }).join('');

      return '' +
        '<article class="skill-group reveal" data-delay="' + (i % 4) + '">' +
          '<div class="skill-group-head">' +
            '<span class="skill-icon" aria-hidden="true">' + svgIcon(group.icon) + '</span>' +
            '<h3>' + esc(group.name) + '</h3>' +
            '<span class="skill-group-count">' + (group.items || []).length + '</span>' +
          '</div>' +
          '<ul class="skill-tags">' + chips + '</ul>' +
        '</article>';
    }).join('');
  }

  function renderProjects() {
    var grid = $('#projects-grid');
    if (!grid) return;

    grid.innerHTML = PROJECTS.map(function (p, i) {
      var colors = p.colors || ['#4f46e5', '#7c3aed'];
      var style = '--c1:' + esc(colors[0]) + ';--c2:' + esc(colors[1]) + ';';

      var tags = (p.tech || []).map(function (t) {
        return '<li><span class="chip">' + esc(t) + '</span></li>';
      }).join('');

      var links = (p.links || []).map(function (link) {
        var iconName = link.type === 'code' ? 'code2' : 'demo';
        return '<a class="project-link" href="' + esc(link.href) + '" ' +
               'aria-label="' + esc(link.label + ' — ' + p.title) + '">' +
               svgIcon(iconName) + '<span>' + esc(link.label) + '</span></a>';
      }).join('');

      return '' +
        '<li>' +
          '<article class="project-card reveal" data-delay="' + (i % 3) + '">' +
            '<div class="project-cover" style="' + style + '">' +
              '<span class="project-badge">' + esc(p.badge || 'Project') + '</span>' +
              '<span class="project-year"><span class="sr-only">Year: </span>' + esc(p.year || '') + '</span>' +
              '<span class="project-initials" aria-hidden="true">' + esc(initials(p.title)) + '</span>' +
            '</div>' +
            '<div class="project-body">' +
              '<h3 class="project-title">' + esc(p.title) + '</h3>' +
              '<p class="project-desc">' + esc(p.description) + '</p>' +
              '<ul class="project-tags">' + tags + '</ul>' +
              '<div class="project-links">' + links + '</div>' +
            '</div>' +
          '</article>' +
        '</li>';
    }).join('');
  }

  function renderTimeline() {
    var list = $('#timeline');
    if (!list) return;

    list.innerHTML = TIMELINE.map(function (item, i) {
      var points = (item.points || []).map(function (pt) {
        return '<li>' + esc(pt) + '</li>';
      }).join('');

      var tags = (item.tags || []).map(function (t) {
        return '<li><span class="chip">' + esc(t) + '</span></li>';
      }).join('');

      return '' +
        '<li class="timeline-item reveal" data-delay="' + (i % 3) + '">' +
          '<div class="timeline-card">' +
            '<div class="timeline-top">' +
              '<span class="timeline-period">' + esc(item.period) + '</span>' +
              '<span class="timeline-kind">' + esc(item.kind) + '</span>' +
            '</div>' +
            '<h3 class="timeline-role">' + esc(item.role) + '</h3>' +
            '<p class="timeline-org">' + esc(item.org) + '</p>' +
            '<p class="timeline-desc">' + esc(item.description) + '</p>' +
            (points ? '<ul class="timeline-points">' + points + '</ul>' : '') +
            (tags ? '<ul class="timeline-tags">' + tags + '</ul>' : '') +
          '</div>' +
        '</li>';
    }).join('');
  }

  /* -----------------------------------------------------------------
     Theme toggle
     The choice lives in this variable for the lifetime of the page.
     No localStorage / sessionStorage is used anywhere in this file.
     ----------------------------------------------------------------- */
  var currentTheme = 'light';         // <- the "memory"
  var userPickedTheme = false;        // once true, we stop following the OS

  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', currentTheme === 'dark' ? '#0b0d14' : '#ffffff');

    var btn = $('#theme-toggle');
    if (btn) {
      var goingDark = currentTheme === 'light';
      btn.setAttribute('aria-pressed', currentTheme === 'dark' ? 'true' : 'false');
      btn.setAttribute(
        'aria-label',
        goingDark ? 'Switch to dark theme' : 'Switch to light theme'
      );
    }
  }

  function initTheme() {
    var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    applyTheme(mq && mq.matches ? 'dark' : 'light');

    // Follow the OS while the visitor hasn't expressed a preference.
    if (mq) {
      var onChange = function (e) {
        if (!userPickedTheme) applyTheme(e.matches ? 'dark' : 'light');
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }

    var btn = $('#theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        userPickedTheme = true;
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
      });
    }
  }

  /* -----------------------------------------------------------------
     Scroll reveal
     ----------------------------------------------------------------- */
  function initReveal() {
    var items = $$('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window) || prefersReducedMotion) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    items.forEach(function (el) { observer.observe(el); });
  }

  /* -----------------------------------------------------------------
     Mobile navigation
     ----------------------------------------------------------------- */
  function initNav() {
    var toggle  = $('#nav-toggle');
    var nav     = $('#primary-nav');
    var overlay = $('#nav-overlay');
    if (!toggle || !nav) return;

    function openNav() {
      nav.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation menu');
      document.body.classList.add('nav-open');
      if (overlay) {
        overlay.hidden = false;
        // next frame so the opacity transition actually runs
        requestAnimationFrame(function () { overlay.classList.add('is-visible'); });
      }
      var first = $('.nav-link', nav);
      if (first) first.focus();
    }

    function closeNav(returnFocus) {
      if (!nav.classList.contains('is-open')) return;
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation menu');
      document.body.classList.remove('nav-open');
      if (overlay) {
        overlay.classList.remove('is-visible');
        window.setTimeout(function () {
          if (!nav.classList.contains('is-open')) overlay.hidden = true;
        }, 280);
      }
      if (returnFocus) toggle.focus();
    }

    toggle.addEventListener('click', function () {
      if (nav.classList.contains('is-open')) closeNav(true);
      else openNav();
    });

    if (overlay) overlay.addEventListener('click', function () { closeNav(false); });

    $$('.nav-link', nav).forEach(function (link) {
      link.addEventListener('click', function () { closeNav(false); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav(true);
    });

    // Keep focus inside the drawer while it is open.
    nav.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !nav.classList.contains('is-open')) return;
      var focusables = $$('a[href], button:not([disabled])', nav);
      if (!focusables.length) return;
      var first = focusables[0];
      var last  = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });

    // Reset state if the viewport grows past the drawer breakpoint.
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 881px)');
      var onWide = function (e) { if (e.matches) closeNav(false); };
      if (typeof wide.addEventListener === 'function') wide.addEventListener('change', onWide);
      else if (typeof wide.addListener === 'function') wide.addListener(onWide);
    }
  }

  /* -----------------------------------------------------------------
     Smooth scrolling for in-page anchors
     (CSS handles it too; this keeps focus management correct)
     ----------------------------------------------------------------- */
  function initSmoothScroll() {
    document.addEventListener('click', function (e) {
      var link = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!link) return;

      var hash = link.getAttribute('href');
      if (!hash || hash === '#' || hash.length < 2) return;

      var target = document.getElementById(hash.slice(1));
      if (!target) return;

      e.preventDefault();
      target.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start'
      });

      // Move focus for screen-reader / keyboard users without re-scrolling.
      var hadTabIndex = target.hasAttribute('tabindex');
      if (!hadTabIndex) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      if (!hadTabIndex) {
        target.addEventListener('blur', function handler() {
          target.removeAttribute('tabindex');
          target.removeEventListener('blur', handler);
        });
      }

      if (history.replaceState) history.replaceState(null, '', hash);
    });
  }

  /* -----------------------------------------------------------------
     Scroll-driven UI: sticky header shadow, progress bar,
     active nav link, back-to-top button.
     ----------------------------------------------------------------- */
  function initScrollUI() {
    var header   = $('#site-header');
    var progress = $('#scroll-progress');
    var toTop    = $('#back-to-top');
    var navLinks = $$('.nav-link');

    var sections = navLinks
      .map(function (link) {
        var id = link.getAttribute('href');
        return id && id.charAt(0) === '#' ? document.getElementById(id.slice(1)) : null;
      })
      .filter(Boolean);

    function setActive(id) {
      navLinks.forEach(function (link) {
        var isActive = Boolean(id) && link.getAttribute('href') === '#' + id;
        link.classList.toggle('is-active', isActive);
        if (isActive) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }

    function onScroll() {
      var y = window.scrollY || window.pageYOffset || 0;

      if (header) header.classList.toggle('is-stuck', y > 8);
      if (toTop) toTop.classList.toggle('is-visible', y > 500);

      if (progress) {
        var doc = document.documentElement;
        var max = (doc.scrollHeight - window.innerHeight) || 1;
        var ratio = Math.min(1, Math.max(0, y / max));
        progress.style.transform = 'scaleX(' + ratio + ')';
      }

      // Active link: the last section whose top has passed the header line.
      var line = y + (parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--header-h'), 10) || 68) + 24;
      // Nothing is highlighted until the first section is actually reached,
      // so the hero doesn't borrow "About"'s highlight.
      var activeId = null;

      for (var i = 0; i < sections.length; i++) {
        if (sections[i].offsetTop <= line) activeId = sections[i].id;
      }
      // Pin the final section when scrolled to the very bottom.
      if (sections.length && y + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        activeId = sections[sections.length - 1].id;
      }
      setActive(activeId);
    }

    var ticking = false;
    function onScrollThrottled() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { onScroll(); ticking = false; });
    }

    window.addEventListener('scroll', onScrollThrottled, { passive: true });
    window.addEventListener('resize', onScrollThrottled);
    onScroll();

    if (toTop) {
      toTop.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
        var brand = $('.brand');
        if (brand) brand.focus({ preventScroll: true });
      });
    }
  }

  /* -----------------------------------------------------------------
     Contact form — client-side validation only, no backend.
     ----------------------------------------------------------------- */
  function initContactForm() {
    var form = $('#contact-form');
    if (!form) return;

    var successPanel = $('#form-success');
    var statusEl     = $('#form-status');
    var submitBtn    = $('#submit-btn');
    var countEl      = $('#message-count');
    var MAX_MESSAGE  = 1000;

    var RULES = {
      name: function (v) {
        if (!v) return 'Please enter your name.';
        if (v.length < 2) return 'Name must be at least 2 characters.';
        if (v.length > 80) return 'Name must be 80 characters or fewer.';
        return '';
      },
      email: function (v) {
        if (!v) return 'Please enter your email address.';
        // Deliberately permissive: local@domain.tld with no spaces.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
          return 'Please enter a valid email address.';
        }
        return '';
      },
      subject: function (v) {
        if (v && v.length > 120) return 'Subject must be 120 characters or fewer.';
        return '';
      },
      message: function (v) {
        if (!v) return 'Please write a message.';
        if (v.length < 10) return 'Message must be at least 10 characters.';
        if (v.length > MAX_MESSAGE) return 'Message must be ' + MAX_MESSAGE + ' characters or fewer.';
        return '';
      }
    };

    function fieldOf(input) { return input.closest('.field'); }

    function showError(input, message) {
      var wrap = fieldOf(input);
      var err  = document.getElementById(input.id + '-error');
      if (wrap) wrap.classList.toggle('has-error', Boolean(message));
      if (err) err.textContent = message || '';
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }

    function validateField(input) {
      var rule = RULES[input.name];
      if (!rule) return true;
      var msg = rule(input.value.trim());
      showError(input, msg);
      return !msg;
    }

    var inputs = $$('input, textarea', form);

    inputs.forEach(function (input) {
      // Validate on blur, then live-correct once the field has been touched.
      input.addEventListener('blur', function () { validateField(input); });
      input.addEventListener('input', function () {
        var wrap = fieldOf(input);
        if (wrap && wrap.classList.contains('has-error')) validateField(input);
        if (statusEl) statusEl.textContent = '';
      });
    });

    var messageEl = $('#message', form);
    if (messageEl && countEl) {
      var updateCount = function () {
        var len = messageEl.value.length;
        countEl.textContent = len + ' / ' + MAX_MESSAGE;
        countEl.classList.toggle('is-over', len > MAX_MESSAGE);
      };
      messageEl.addEventListener('input', updateCount);
      updateCount();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var firstInvalid = null;
      inputs.forEach(function (input) {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
      });

      if (firstInvalid) {
        if (statusEl) statusEl.textContent = 'Please fix the highlighted fields and try again.';
        firstInvalid.focus();
        return;
      }

      if (statusEl) statusEl.textContent = '';

      // Simulate a network round-trip so the success state feels real.
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('is-sending');
      }

      window.setTimeout(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('is-sending');
        }
        if (successPanel) {
          // Match the form's height first so nothing below it jumps.
          successPanel.hidden = false;
          var heading = $('h3', successPanel);
          if (heading) {
            heading.setAttribute('tabindex', '-1');
            heading.focus({ preventScroll: true });
          }
        }
      }, prefersReducedMotion ? 0 : 700);
    });

    var again = $('#send-another');
    if (again) {
      again.addEventListener('click', function () {
        form.reset();
        inputs.forEach(function (input) { showError(input, ''); });
        if (countEl) {
          countEl.textContent = '0 / ' + MAX_MESSAGE;
          countEl.classList.remove('is-over');
        }
        if (successPanel) successPanel.hidden = true;
        if (statusEl) statusEl.textContent = '';
        var nameEl = $('#name', form);
        if (nameEl) nameEl.focus();
      });
    }
  }

  /* -----------------------------------------------------------------
     Misc
     ----------------------------------------------------------------- */
  function initYear() {
    var el = $('#year');
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* -----------------------------------------------------------------
     Boot
     ----------------------------------------------------------------- */
  function init() {
    document.documentElement.classList.remove('no-js');

    renderSkills();
    renderProjects();
    renderTimeline();

    initTheme();
    initNav();
    initSmoothScroll();
    initScrollUI();
    initContactForm();
    initReveal();   // after rendering, so generated cards are observed
    initYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
