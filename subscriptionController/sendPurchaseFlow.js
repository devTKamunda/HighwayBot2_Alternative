// Sends the dynamic WhatsApp purchase Flow.
//
// Usage:
// await sendPurchaseFlow(user, "resources");
// await sendPurchaseFlow(user, "subscription");

import axios from "axios";
import dotenv from "dotenv";
import { setPurchaseFlowVariable } from "../userStateManager.js";

dotenv.config();

export async function sendPurchaseFlow(user, requestedMode) {
  let mode = requestedMode;
  setPurchaseFlowVariable(user, "mode", mode);


  if (mode !== "resources" && mode !== "subscription") {
    const error =
      'User messageState must be "resources" or "subscription" before sending the purchase Flow.';

    console.error("[PurchaseFlow] Invalid messageState:", {
      mode,
      expected: ["resources", "subscription"],
    });

    return {
      success: false,
      error,
    };
  }

  // --------------------------------------------------
  // 2. Validate environment configuration
  // --------------------------------------------------

  const token = process.env.GRAPH_API_TOKEN;
  const phoneNumberId = process.env.MY_PHONE_NUMBER_ID;
  const flowId = process.env.PURCHASE_FLOW_ID;

  const missing = [
    !token && "GRAPH_API_TOKEN",
    !phoneNumberId && "MY_PHONE_NUMBER_ID",
    !flowId && "PURCHASE_FLOW_ID",
  ].filter(Boolean);



  if (missing.length) {
    const error = `Purchase Flow configuration is incomplete: ${missing.join(", ")}`;

    console.error("[PurchaseFlow] Configuration error:", error);

    return {
      success: false,
      error,
    };
  }

  // --------------------------------------------------
  // 3. Prepare Flow message
  // --------------------------------------------------


  const isSubscription = mode === "subscription";

  const headerText = isSubscription
    ? "Choose a Subscription"
    : "Pdf Study Resources";

  const bodyText = isSubscription
    ? "Choose your access package, use EcoCash to pay and instantly have access to all features and start your driving journey. \n\nType *Menu* for the Assistant's Main Menu."
    : "Choose your study resource, use EcoCash to pay and instantly receive your selected pdf study resource. \n\nType *Menu* for the Assistant's Main Menu.";

  // Normalize the recipient for logging only.
  const recipient = String(user ?? "");


  // --------------------------------------------------
  // 4. Send Flow through the WhatsApp Cloud API
  // --------------------------------------------------

  try {
    const requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "flow",
        header: {
          type: "text",
          text: headerText,
        },
        body: {
          text: bodyText,
        },
        footer: {
          text: "Zim Provisional Driver's Licence Assistant",
        },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: flowId,
            flow_cta: "Continue",
            flow_action: "data_exchange",

            // The Flow endpoint uses this to identify the user.
            flow_token: `purchase:${recipient}`,
          },
        },
      },
    };

    const response = await axios({
      method: "POST",
      url: `https://graph.facebook.com/v26.0/${phoneNumberId}/messages`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: requestBody,
      timeout: 30000,
    });

    return {
      success: true,
      mode,
      data: response.data,
    };
  } catch (error) {
    // --------------------------------------------------
    // 5. Log the actual error returned by Meta or Axios
    // --------------------------------------------------

    const metaError = error.response?.data?.error;

    console.error("[PurchaseFlow] ===== REQUEST FAILED =====");

    console.error("[PurchaseFlow] Error details:", {
      message: error.message,
      code: error.code ?? null,
      status: error.response?.status ?? null,
      statusText: error.response?.statusText ?? null,
      metaErrorType: metaError?.type ?? null,
      metaErrorCode: metaError?.code ?? null,
      metaErrorSubcode: metaError?.error_subcode ?? null,
      metaErrorMessage: metaError?.message ?? null,
      metaErrorUserTitle: metaError?.error_user_title ?? null,
      metaErrorUserMessage: metaError?.error_user_msg ?? null,
      metaErrorDetails: metaError?.error_data?.details ?? null,
      isAxiosError: axios.isAxiosError(error),
      timedOut: error.code === "ECONNABORTED",
    });

    if (error.response?.data) {
      console.error(
        "[PurchaseFlow] Full Meta API response:",
        JSON.stringify(error.response.data, null, 2)
      );
    } else {
      console.error(
        "[PurchaseFlow] No HTTP response received. Check network, DNS, and timeout details."
      );
    }

    console.error("[PurchaseFlow] ===== END: FAILURE =====\n");

    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
}

export default sendPurchaseFlow;
