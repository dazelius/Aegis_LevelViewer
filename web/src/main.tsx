import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import LevelList from './pages/LevelList';
import LevelViewer from './pages/LevelViewer';
import './styles.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<LevelList />} />
          <Route path="level/*" element={<LevelViewer />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
