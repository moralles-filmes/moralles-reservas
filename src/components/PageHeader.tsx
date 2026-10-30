import { Breadcrumb, type BreadcrumbItem } from "@/components/Breadcrumb";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  breadcrumb?: BreadcrumbItem[];
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({ breadcrumb, title, description, children, className }: PageHeaderProps) {
  return (
    <header className={cn("space-y-2", className)}>
      {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} />}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1 min-w-0">
          <h1 className="text-[28px] sm:text-[30px] font-semibold tracking-[-0.02em] text-foreground">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
      </div>
    </header>
  );
}
