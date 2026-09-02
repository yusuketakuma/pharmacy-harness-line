import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
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
import MainMenuPage from './custom/pharmacy/menu/MainMenuPage.js'; // custom:pharmacy-menu
import PharmacyInfoPage from './custom/pharmacy/public-profile/PharmacyInfoPage.js'; // custom:pharmacy-public-profile
import PatientTimelinePage from './custom/pharmacy/timeline/PatientTimelinePage.js'; // custom:pharmacy-patient-timeline
import { deprecatedReceiveTarget } from './custom/pharmacy/navigation.js';
import PharmacyFeatureGate from './custom/pharmacy/menu/PharmacyFeatureGate.js';
import { PharmacyAccessProvider, PharmacyShell } from './custom/pharmacy/PharmacyShell.js';

const DeferredEmergencyContraceptionPage = lazy(() => import('./custom/pharmacy/emergency-contraception/EmergencyContraceptionPage.js')); // custom:pharmacy-emergency-contraception

function EmergencyContraceptionPage() {
  return <Suspense fallback={<p role="status" className="py-6 text-center text-gray-600">画面を読み込んでいます…</p>}>
    <DeferredEmergencyContraceptionPage />
  </Suspense>;
}

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
  const screenTitle = view === 'electronic' ? '電子処方箋' : view === 'history' ? '受付状況' : '処方せん事前送信';
  return <PharmacyPage screenTitle={screenTitle} capability={capability} allowExisting={allowExisting}>
    <PrescriptionPage />
  </PharmacyPage>;
}

function PharmacyPage({ screenTitle, capability, allowExisting = false, children }: {
  screenTitle: string;
  capability?: import('./custom/pharmacy/menu/PharmacyFeatureGate.js').PatientFeature;
  allowExisting?: boolean;
  children: ReactNode;
}) {
  return <PharmacyAccessProvider>
    <PharmacyShell screenTitle={screenTitle}>
      {capability
        ? <PharmacyFeatureGate capability={capability} allowExisting={allowExisting}>{children}</PharmacyFeatureGate>
        : children}
    </PharmacyShell>
  </PharmacyAccessProvider>;
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
      <Route path="/pharmacy/menu" element={<PharmacyPage screenTitle="すべての機能"><MainMenuPage /></PharmacyPage>} /> {/* custom:pharmacy-menu */}
      <Route path="/pharmacy/timeline" element={<PharmacyPage screenTitle="利用状況"><PatientTimelinePage /></PharmacyPage>} /> {/* custom:pharmacy-patient-timeline */}
      <Route path="/pharmacy/info" element={<PharmacyPage screenTitle="薬局情報" capability="pharmacy_info"><PharmacyInfoPage /></PharmacyPage>} /> {/* custom:pharmacy-public-profile */}
      <Route path="/pharmacy/patient-intake" element={<PharmacyPage screenTitle="患者アンケート" capability="patient_intake" allowExisting><PatientIntakePage /></PharmacyPage>} /> {/* custom:pharmacy-intake */}
      <Route path="/pharmacy/continuity" element={<PharmacyPage screenTitle="継続フォロー" capability="continuity" allowExisting><ContinuityPage /></PharmacyPage>} /> {/* custom:pharmacy-continuity */}
      <Route path="/pharmacy/receive" element={<DeprecatedReceiveRedirect />} /> {/* custom:pharmacy-myna */}
      <Route path="/pharmacy/medication-followup" element={<PharmacyPage screenTitle="服薬後フォロー" capability="medication_followup" allowExisting><MedicationFollowUpPage /></PharmacyPage>} /> {/* custom:pharmacy-medication-followup */}
      <Route path="/pharmacy/emergency-contraception" element={<PharmacyPage screenTitle="緊急避妊薬" capability="emergency_contraception" allowExisting><EmergencyContraceptionPage /></PharmacyPage>} /> {/* custom:pharmacy-emergency-contraception */}
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
