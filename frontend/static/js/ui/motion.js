// frontend/static/js/ui/motion.js
// Helpers that only animate transform / opacity / filter.

const SPRING = "700ms cubic-bezier(0.32, 0.72, 0, 1)";

export function enter(node, { delay = 0, distance = 16 } = {}) {
  node.style.opacity = "0";
  node.style.transform = `translateY(${distance}px)`;
  node.style.filter = "blur(6px)";
  node.style.transition = `opacity ${SPRING} ${delay}ms, transform ${SPRING} ${delay}ms, filter ${SPRING} ${delay}ms`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    node.style.opacity = "1";
    node.style.transform = "translateY(0)";
    node.style.filter = "blur(0)";
  }));
}

export function lift(node) {
  node.addEventListener("mouseenter", () => {
    node.style.transform = "translateY(-2px)";
  });
  node.addEventListener("mouseleave", () => {
    node.style.transform = "";
  });
}

export function magnetic(button) {
  const nest = button.querySelector(".nest");
  if (!nest) return;
  button.addEventListener("mouseenter", () => {
    nest.style.transform = "translate(2px, -1px) scale(1.05)";
  });
  button.addEventListener("mouseleave", () => {
    nest.style.transform = "";
  });
  button.addEventListener("mousedown", () => {
    button.style.transform = "scale(0.98)";
  });
  button.addEventListener("mouseup", () => {
    button.style.transform = "";
  });
}

export function staggerChildren(parent, { each = 60 } = {}) {
  const kids = Array.from(parent.children);
  kids.forEach((k, i) => enter(k, { delay: i * each }));
}

export function observeEntries(root) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        enter(e.target);
        io.unobserve(e.target);
      }
    }
  }, { rootMargin: "0px 0px -10%" });
  root.querySelectorAll("[data-enter]").forEach(n => io.observe(n));
}
