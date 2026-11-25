import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from './App';

it('shows the product name and the Cisco disclaimer', () => {
  render(<App />);

  expect(screen.getByRole('heading', { level: 1, name: 'Tracer' })).toBeInTheDocument();
  expect(screen.getByText(/not affiliated with .*Cisco/)).toBeInTheDocument();
});
