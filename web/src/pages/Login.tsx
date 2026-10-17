import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api";

export function Login() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const { token } = await api<{ token: string }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      });
      setToken(token);
      navigate("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="auth">
      <h1>EscutaIA</h1>
      <p className="muted">Grave, transcreva e pesquise suas reuniões.</p>
      <form onSubmit={submit} className="card stack">
        {mode === "signup" && <input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} />}
        <input type="email" placeholder="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          placeholder="Senha (mín. 8 caracteres)"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">{mode === "login" ? "Entrar" : "Criar conta"}</button>
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Não tem conta? Criar" : "Já tenho conta"}
        </button>
      </form>
    </div>
  );
}
