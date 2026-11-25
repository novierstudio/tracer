import iconUrl from '../../assets/icon.svg';

export function App() {
  return (
    <main className="placeholder">
      <img src={iconUrl} width={96} height={96} alt="" />
      <h1>Tracer</h1>
      <p className="disclaimer">
        Tracer is an independent project and is not affiliated with or endorsed by Cisco Systems.
      </p>
    </main>
  );
}
