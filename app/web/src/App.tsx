import { Navigate, Route, Routes } from 'react-router'
import { PublicOnly, RequireAuth } from './auth/RouteGuards'
import ConfirmEmail from './pages/ConfirmEmail'
import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'

function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>
      {/* Reached from the email link; not guarded, because it signs the user in itself. */}
      <Route path="/auth/confirm" element={<ConfirmEmail />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
