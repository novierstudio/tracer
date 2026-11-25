import iconUrl from '../../assets/icon.svg';

export function App() {
  return (
    <main className="grid min-h-full place-content-center justify-items-center gap-3 p-4 text-center">
      <img src={iconUrl} width={96} height={96} alt="" />
      <h1 className="text-4xl font-semibold">Tracer</h1>
      <p className="text-fg-2">
        Tracer is an independent project and is not affiliated with or endorsed by Cisco Systems.
      </p>
    </main>
  );
}
