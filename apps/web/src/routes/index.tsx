import { convexQuery } from "@convex-dev/react-query";
import { api } from "@pi-personal/backend/convex/_generated/api";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

interface ApiStatus {
	dotClassName: string;
	label: string;
}

function apiStatus(data: string | undefined, isLoading: boolean): ApiStatus {
	if (data === "OK") {
		return { dotClassName: "bg-green-500", label: "Connected" };
	}
	if (isLoading) {
		return { dotClassName: "bg-orange-400", label: "Checking..." };
	}
	return { dotClassName: "bg-red-500", label: "Error" };
}

function HomeComponent() {
	const healthCheck = useQuery(convexQuery(api.healthCheck.get, {}));
	const status = apiStatus(healthCheck.data, healthCheck.isLoading);

	return (
		<div className="container mx-auto max-w-3xl px-4 py-2">
			<h1 className="my-6 font-semibold text-2xl">pi-personal</h1>
			<div className="grid gap-6">
				<section className="rounded-lg border p-4">
					<h2 className="mb-2 font-medium">API Status</h2>
					<div className="flex items-center gap-2">
						<div className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
						<span className="text-muted-foreground text-sm">
							{status.label}
						</span>
					</div>
				</section>
			</div>
		</div>
	);
}
