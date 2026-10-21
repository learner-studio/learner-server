-- Expand only the assessment lane; archive stays at three and index at one.
-- This widens the constraint without changing active dispatch identities.
ALTER TABLE learning_reactive_admission
  DROP CONSTRAINT learning_active_archive_sessions_active_slot_check,
  ADD CONSTRAINT learning_reactive_admission_active_slot_check
    CHECK (active_slot BETWEEN 1 AND 9);
