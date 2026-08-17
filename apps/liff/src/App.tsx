import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Booking from './pages/Booking.js';
import BookingHistory from './pages/BookingHistory.js';
import Event from './pages/Event.js';
import EventConfirm from './pages/EventConfirm.js';
import EventDone from './pages/EventDone.js';
import EventBookings from './pages/EventBookings.js';
import Affiliate from './pages/Affiliate.js';
import Webinar from './pages/Webinar.js';
import { legacyQueryTarget } from './legacy-route.js';
import PrescriptionPage from './custom/pharmacy/prescriptions/PrescriptionPage.js'; // custom:pharmacy-prescriptions
import PatientIntakePage from './custom/pharmacy/intake/PatientIntakePage.js'; // custom:pharmacy-intake
import ContinuityPage from './custom/pharmacy/continuity/ContinuityPage.js'; // custom:pharmacy-continuity
import MynaReceivePage from './custom/pharmacy/myna/MynaReceivePage.js'; // custom:pharmacy-myna

function LegacyEntryRedirect() {
  const location = useLocation();
  return <Navigate to={legacyQueryTarget(location.search)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/booking" element={<Booking />} />
      <Route path="/booking/history" element={<BookingHistory />} />
      <Route path="/events/me" element={<EventBookings />} />
      <Route path="/events/:id/confirm" element={<EventConfirm />} />
      <Route path="/events/:id/done" element={<EventDone />} />
      <Route path="/events/:id" element={<Event />} />
      <Route path="/affiliate" element={<Affiliate />} />
      <Route path="/webinar/:slug" element={<Webinar />} />
      <Route path="/prescriptions" element={<PrescriptionPage />} /> {/* custom:pharmacy-prescriptions */}
      <Route path="/pharmacy/patient-intake" element={<PatientIntakePage />} /> {/* custom:pharmacy-intake */}
      <Route path="/pharmacy/continuity" element={<ContinuityPage />} /> {/* custom:pharmacy-continuity */}
      <Route path="/pharmacy/receive" element={<MynaReceivePage />} /> {/* custom:pharmacy-myna */}
      <Route path="/" element={<LegacyEntryRedirect />} />
      <Route
        path="*"
        element={
          <div className="p-8 text-center text-gray-500">
            ページが見つかりませんでした
          </div>
        }
      />
    </Routes>
  );
}
