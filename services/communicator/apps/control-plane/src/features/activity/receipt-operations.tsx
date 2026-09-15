import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  ReadReceiptOperation,
  ReceiptOperationStatus,
} from "@communicator/contracts";

const statusVariant = (status: ReceiptOperationStatus) => {
  if (status === "accepted" || status === "observed") return "default" as const;
  if (status === "rejected") return "destructive" as const;
  return "secondary" as const;
};

const stageVariant = (stage: string) => {
  if (stage === "accepted" || stage === "observed" || stage === "confirmed")
    return "default" as const;
  return "secondary" as const;
};

function stageLabel(stage: string) {
  return stage === "unknown" ? "Unknown" : stage;
}

export function ReceiptOperations({
  operations,
}: {
  operations: ReadReceiptOperation[];
}) {
  return (
    <section aria-labelledby="read-receipts-heading" className="space-y-4">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Account-bound read receipts
        </p>
        <h2
          id="read-receipts-heading"
          className="mt-1 text-2xl font-semibold tracking-tight"
        >
          Read receipts
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Matrix acceptance, bridge observation, and provider confirmation are
          recorded separately. A stored read never implies provider delivery.
        </p>
      </div>
      {operations.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No read receipt operations are available for this tenant.
        </p>
      ) : (
        <div className="grid gap-4">
          {operations.map((operation) => (
            <Card key={operation.operation_id}>
              <CardHeader className="border-b">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>{operation.message_id}</CardTitle>
                  <Badge variant={statusVariant(operation.status)}>
                    {operation.status}
                  </Badge>
                </div>
                <CardDescription>
                  Operation {operation.operation_id} · conversation{" "}
                  {operation.conversation_id}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 pt-6 text-sm">
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { label: "Matrix", stage: operation.matrix_stage },
                    { label: "Bridge", stage: operation.bridge_stage },
                    { label: "Provider", stage: operation.provider_stage },
                  ].map(({ label, stage }) => (
                    <div key={label} className="rounded-md border p-3">
                      <p className="font-medium">{label} stage</p>
                      <Badge className="mt-2" variant={stageVariant(stage)}>
                        {stageLabel(stage)}
                      </Badge>
                    </div>
                  ))}
                </div>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="font-medium">Account</dt>
                    <dd className="text-muted-foreground">
                      {operation.account_id}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium">Updated</dt>
                    <dd className="text-muted-foreground">
                      {operation.updated_at}
                    </dd>
                  </div>
                  {operation.failure_code !== null && (
                    <div className="sm:col-span-2">
                      <dt className="font-medium">Failure / uncertainty</dt>
                      <dd className="text-muted-foreground">
                        {operation.failure_code}
                        {operation.failure_reason
                          ? ` · ${operation.failure_reason}`
                          : ""}
                      </dd>
                    </div>
                  )}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
