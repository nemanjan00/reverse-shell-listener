// Self-contained Dracula-themed login page (no external assets, so it needs no
// auth to render).
export function loginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Login — Reverse Shell Listener</title>
<style>
  :root{--bg:#282a36;--darker:#21222c;--fg:#f8f8f2;--comment:#6272a4;
        --purple:#bd93f9;--pink:#ff79c6;--red:#ff5555;--border:#343746}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--fg);
       font-family:"JetBrains Mono","Fira Code",ui-monospace,Menlo,monospace;
       display:grid;place-items:center}
  .card{width:340px;background:var(--darker);border:1px solid var(--border);
        border-radius:14px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  .logo{width:44px;height:44px;border-radius:12px;
        background:linear-gradient(135deg,var(--purple),var(--pink));
        display:grid;place-items:center;color:#21222c;font-weight:800;
        font-size:18px;margin-bottom:16px}
  h1{font-size:16px;margin:0 0 2px}
  .sub{color:var(--comment);font-size:12px;margin-bottom:20px}
  label{display:block;font-size:11px;color:var(--comment);text-transform:uppercase;
        letter-spacing:1px;margin:14px 0 6px}
  input{width:100%;background:var(--bg);border:1px solid var(--border);
        border-radius:8px;color:var(--fg);font-family:inherit;font-size:14px;
        padding:10px 12px;outline:none}
  input:focus{border-color:var(--purple)}
  button{width:100%;margin-top:22px;background:var(--purple);color:#21222c;
         border:none;border-radius:8px;font-family:inherit;font-weight:700;
         font-size:14px;padding:11px;cursor:pointer}
  button:hover{filter:brightness(1.1)}
  .err{margin-top:16px;color:var(--red);font-size:12px;text-align:center;
       ${error ? "" : "display:none"}}
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <div class="logo">»_</div>
    <h1>Reverse Shell Listener</h1>
    <div class="sub">Operator login</div>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
    <div class="err">Invalid credentials</div>
  </form>
</body>
</html>`;
}
