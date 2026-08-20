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
import MedicationFollowUpPage from './custom/pharmacy/medication-followup/MedicationFollowUpPage.js'; // custom:pharmacy-medication-followup
import EmergencyContraceptionPage from './custom/pharmacy/emergency-contraception/EmergencyContraceptionPage.js'; // custom:pharmacy-emergency-contraception
import MainMenuPage from './custom/pharmacy/menu/MainMenuPage.js'; // custom:pharmacy-menu
import PharmacyInfoPage from './custom/pharmacy/public-profile/PharmacyInfoPage.js'; // custom:pharmacy-public-profile
import { deprecatedReceiveTarget } from './custom/pharmacy/navigation.js';
import PharmacyFeatureGate from './custom/pharmacy/menu/PharmacyFeatureGate.js';

function LegacyEntryRedirect() {
  const location = useLocation();
  return <Navigate to={legacyQueryTarget(location.search)} replace />;
}

function DeprecatedReceiveRedirect() {
  return <Navigate to={deprecatedReceiveTarget(useLocation().search)} replace />;
}

function PrescriptionRoute() {
  const view = new URLSearchParams(useLocation().search).get('view');
  const capability = view === 'electronic' ? 'electronic_prescription' : 'prescription_intake';
  const allowExisting = view === 'history' || view === 'electronic';
  return <PharmacyFeatureGate key={`${capability}:${allowExisting}`} capability={capability} allowExisting={allowExisting}>
    <PrescriptionPage />
  </PharmacyFeatureGate>;
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
      <Route path="/prescriptions" element={<PrescriptionRoute />} /> {/* custom:pharmacy-prescriptions */}
      <Route path="/pharmacy/menu" element={<MainMenuPage />} /> {/* custom:pharmacy-menu */}
      <Route path="/pharmacy/info" element={<PharmacyFeatureGate capability="pharmacy_info"><PharmacyInfoPage /></PharmacyFeatureGate>} /> {/* custom:pharmacy-public-profile */}
      <Route path="/pharmacy/patient-intake" element={<PharmacyFeatureGate capability="patient_intake" allowExisting><PatientIntakePage /></PharmacyFeatureGate>} /> {/* custom:pharmacy-intake */}
      <Route path="/pharmacy/continuity" element={<PharmacyFeatureGate capability="continuity" allowExisting><ContinuityPage /></PharmacyFeatureGate>} /> {/* custom:pharmacy-continuity */}
      <Route path="/pharmacy/receive" element={<DeprecatedReceiveRedirect />} /> {/* custom:pharmacy-myna */}
      <Route path="/pharmacy/medication-followup" element={<PharmacyFeatureGate capability="medication_followup" allowExisting><MedicationFollowUpPage /></PharmacyFeatureGate>} /> {/* custom:pharmacy-medication-followup */}
      <Route path="/pharmacy/emergency-contraception" element={<PharmacyFeatureGate capability="emergency_contraception" allowExisting><EmergencyContraceptionPage /></PharmacyFeatureGate>} /> {/* custom:pharmacy-emergency-contraception */}
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
