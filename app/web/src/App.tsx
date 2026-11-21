import { Navigate, Route, Routes } from 'react-router'
import { PublicOnly, RequireAuth } from './auth/RouteGuards'
import AddSubscription from './pages/AddSubscription'
import ConfirmEmail from './pages/ConfirmEmail'
import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'
import SubscriptionDetail from './pages/SubscriptionDetail'

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
        <Route path="/subscriptions/new" element={<AddSubscription />} />
        <Route path="/subscriptions/:id" element={<SubscriptionDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
