import { useNavigate } from 'react-router-dom';

import ReceivingForm from '../components/receiving/ReceivingForm';

import { getBranchLabel } from '../lib/branches';

import { useAuth } from '../lib/hooks/useAuth';

import { confirmReceiving } from '../lib/receiving/confirmReceiving';

import type { ReceivingFormSubmitPayload } from '../lib/receiving/receivingFormUtils';

import { saveReceivingDraft } from '../lib/receivingHistory/saveReceivingDraft';

import './ReceivingPage.css';



export default function ReceivingPage() {

  const navigate = useNavigate();

  const { branchId, user } = useAuth();



  if (!branchId) {

    return (

      <div className="rcv-page">

        <div className="rcv-loading">กรุณาเลือกสาขาก่อนใช้งาน</div>

      </div>

    );

  }



  const staffName = user ? `${user.firstName} ${user.lastName}`.trim() : '';



  const handleSubmit = async (payload: ReceivingFormSubmitPayload) => {

    if (!user) return;

    await confirmReceiving({

      branchId,

      staffId: user.id,

      staffName,

      supplierId: payload.supplierId,

      supplierName: payload.supplierName,

      note: payload.composedNote,

      finalDiscount: payload.finalDiscount,

      lines: payload.lines,

    });

  };



  const handleSaveDraft = async (payload: ReceivingFormSubmitPayload) => {

    if (!user) return;

    const receivingId = await saveReceivingDraft({

      branchId,

      staffId: user.id,

      supplierId: payload.supplierId,

      supplierName: payload.supplierName,

      note: payload.composedNote,

      finalDiscount: payload.finalDiscount,

      lines: payload.lines,

    });

    navigate(`/receiving/history/edit/${receivingId}`, {
      replace: true,
      state: { toast: 'บันทึกแบบร่างแล้ว' },
    });

  };



  return (

    <div className="rcv-page">

      <ReceivingForm

        mode="create"

        variant="page"

        branchId={branchId}

        branchLabel={getBranchLabel(branchId)}

        staffId={user?.id}

        onSubmit={handleSubmit}

        onSaveDraft={handleSaveDraft}

      />

    </div>

  );

}


