import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="fatal">
          <h1>Что-то пошло не так</h1>
          <p>Интерфейс столкнулся с ошибкой. Ваш проект сохранён автоматически.</p>
          <pre className="log small">{String(this.state.error?.stack || this.state.error)}</pre>
          <button className="btn primary" onClick={() => location.reload()}>Перезапустить интерфейс</button>
        </div>
      );
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>,
);
