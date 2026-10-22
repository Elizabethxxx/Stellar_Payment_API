"use client";

export interface CreatedPayment {
  payment_id: string;
  payment_link: string;
  status: string;
}

export type CreatePaymentStage = "editing" | "submitting" | "optimistic" | "success" | "rollback";

export interface SavedFormState {
  amount: string;
  asset: "XLM" | "USDC";
  recipient: string;
  description: string;
  useSessionBranding: boolean;
  branding: {
    primary_color: string;
    secondary_color: string;
    background_color: string;
  };
  selectedTrustedAddress: string;
}

export interface CreatePaymentFlowState {
  stage: CreatePaymentStage;
  created: CreatedPayment | null;
  savedFormState: SavedFormState | null;
  rollbackError: string | null;
}

export type CreatePaymentFlowAction =
  | { type: "submit" }
  | { type: "optimistic"; created: CreatedPayment; savedFormState: SavedFormState }
  | { type: "confirm_success"; created: CreatedPayment }
  | { type: "rollback"; error: string }
  | { type: "reset" }
  | { type: "clear_rollback_error" }
  | { type: "failure" };

export const initialCreatePaymentFlowState: CreatePaymentFlowState = {
  stage: "editing",
  created: null,
  savedFormState: null,
  rollbackError: null,
};

export function createPaymentFlowReducer(
  state: CreatePaymentFlowState,
  action: CreatePaymentFlowAction,
): CreatePaymentFlowState {
  switch (action.type) {
    case "submit":
      return {
        ...state,
        stage: "submitting",
      };
    case "optimistic":
      // Show success UI immediately while API call is in progress
      return {
        stage: "optimistic",
        created: action.created,
        savedFormState: action.savedFormState,
        rollbackError: null,
      };
    case "confirm_success":
      // API call succeeded, transition from optimistic to confirmed success with real data
      return {
        stage: "success",
        created: action.created,
        savedFormState: null,
        rollbackError: null,
      };
    case "rollback":
      // API call failed, restore form with error message
      return {
        stage: "rollback",
        created: null,
        savedFormState: state.savedFormState,
        rollbackError: action.error,
      };
    case "clear_rollback_error":
      return {
        ...state,
        stage: "editing",
        rollbackError: null,
        savedFormState: null,
      };
    case "failure":
      return {
        ...state,
        stage: "editing",
        created: null,
      };
    case "reset":
      return initialCreatePaymentFlowState;
    default:
      return state;
  }
}
