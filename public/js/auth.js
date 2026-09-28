const $ = (id) => document.getElementById(id);
const views = { login: $("login-view"), signup: $("signup-view"), forgot: $("forgot-view"), reset: $("reset-view") };

function show(view) {
  for (const [k, el] of Object.entries(views)) {
    el.hidden = k !== view;
  }
}

for (const btn of document.querySelectorAll("[data-goto]")) {
  btn.addEventListener("click", () => show(btn.dataset.goto));
}

const params = new URLSearchParams(location.search);
if (params.has("token")) show("reset");
else if (params.get("view") === "signup") show("signup");

async function api(path, body) {
  const res = await fetch("/api/auth" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "something went wrong");
  return data;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("login-error");
  err.textContent = "";
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api("/login", { username: fd.get("username"), password: fd.get("password") });
    location.href = "/";
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("signup-error");
  err.textContent = "";
  const fd = new FormData(e.target);
  if (fd.get("password") !== fd.get("confirm")) {
    err.textContent = "passwords don't match";
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api("/signup", {
      username: fd.get("username"),
      email: fd.get("email"),
      password: fd.get("password"),
    });
    location.href = "/";
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$("forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("forgot-error");
  const ok = $("forgot-success");
  err.textContent = "";
  ok.textContent = "";
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api("/forgot-password", { email: fd.get("email") });
    ok.textContent = "if that email is registered, a reset link has been generated. check your server logs.";
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$("reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("reset-error");
  const ok = $("reset-success");
  err.textContent = "";
  ok.textContent = "";
  const fd = new FormData(e.target);
  if (fd.get("password") !== fd.get("confirm")) {
    err.textContent = "passwords don't match";
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api("/reset-password", { token: params.get("token"), password: fd.get("password") });
    ok.textContent = "password reset! redirecting to login...";
    setTimeout(() => (location.href = "/auth.html"), 1500);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
